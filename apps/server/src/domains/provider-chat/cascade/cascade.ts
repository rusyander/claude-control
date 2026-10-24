import type { AppSettings, ModelInfo, ProviderChatDetail } from '@agentdeck/contracts';
import {
  deliverStagePrompt,
  fixStagePrompt,
  loweredWorkPrompt,
  reviewStagePrompt,
  verifyStagePrompt,
  scanReviewBlocks,
  type CascadeStage,
  type StageContext,
  type TaskKind,
} from '@agentdeck/contracts/model-cascade';
import {
  raisedWorkPrompt,
  scanPlanBlocks,
  workAfterPlanPrompt,
  TASK_MAX_CHARS,
} from '@agentdeck/contracts/split-plan';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { resolveSonnetDeliver } from '@agentdeck/contracts/group-economy';
import { labelledCut } from '@agentdeck/contracts/quality-floor';
import {
  mergeSieveRows,
  scanSieveBlocks,
  type SieveReportRow,
  type SieveStage,
  stampSieveRows,
} from '@agentdeck/contracts/sieves';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import { carriedStageLink } from '../../../lib/app-store/chat-links.ts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import type { RunOptions } from '../../chat/ChatRunner/ChatRunner.ts';
import type { RunMeta } from '../../chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent } from '../../chat/chat-events.ts';
import type { TreeStartGate } from '../../chat/tree-pause/tree-pause.ts';
import { fillSieveSlot, SIEVE_SLOT, type SieveAsk } from '../../chat/sieve-gate/sieve-gate.ts';
import { initiativePrompt } from '../../chat/initiative/initiative.ts';
import { reviewNoticeText } from '../../chat/split-review/split-review.ts';
import {
  chainOutcomeOf,
  waitsForAnswer,
  type ChainOutcomeInput,
} from '../../chat/chain-outcome/chain-outcome.ts';
import { asksDelivery } from '../../chat/ChatCascadeStages/ChatCascadeStages.ts';
import type { ChainOutcome } from '../../chat/split-conveyor/split-conveyor.ts';
import type { HandoffChains, HashFile, StatFile } from '../../chat/ChatHandoff/ChatHandoff.ts';
import { planForeignHandoff, type ForeignHandoffDeps } from '../handoff/handoff.ts';
import { foreignPathTurn, type ForeignPathTurnDeps } from '../path-turn/path-turn.ts';
import {
  withForeignCheapDeliver,
  workDeliverAfterRefusal,
  type DeliverContourRoute,
} from './cheap-deliver.ts';
import {
  appendMessage,
  createChat,
  readChat,
  readChatCascade,
  setChatCascade,
} from '../store/store.ts';
import type { ProviderChatCascade } from '../store/store.ts';
import type {
  ProviderChatRunDeps,
  ProviderChatService,
} from '../ProviderChatService/ProviderChatService.ts';

/**
 * Конвейер «работа → ревью → правки» у ЧУЖОГО CLI.
 *
 * Тот же смысл, что у Claude (`domains/chat/ChatCascadeStages/ChatCascadeStages.ts`): панель
 * отправила группу на модель ниже — плата за это вторая пара глаз. Разница одна,
 * зато определяющая: у чужого провайдера ПОТОЛКА НЕТ. Панель не знает, чем
 * настроен CLI, и умеет только понижать относительно этой настройки (см.
 * `domains/provider-cascade/provider-cascade.ts`). Поэтому ревью здесь — это прогон БЕЗ подобранной
 * ступени, то есть ровно то, чем работа шла бы без панели вовсе; «модель
 * сильнее» тут не обещается никому, ни агенту, ни человеку.
 *
 * Почему это не поехало через `ChatRunRegistry`, как у Claude. Реестр ведёт
 * прогоны Claude Code: сессии, транскрипты, права, стоимость. Чужой чат ничего
 * этого не имеет — у него переписка в своём файле и одноразовый запуск CLI.
 * Протаскивать одно через другое значит править ядро запуска ради того, что
 * здесь решается одним слушателем на завершении прогона: `ProviderChatService`
 * и так знает точку «ответ закончился», а стадия лежит в шапке разговора рядом
 * с назначенной моделью.
 *
 * Цепочка конечна по построению, отдельного счётчика ей не нужно: `work` даёт
 * ровно одно `review` (и только раз — по отметке `reviewedAt`), `review` даёт
 * `fix` только по НЕПУСТОМУ списку замечаний, `fix` — один проход проверки
 * (U6: стадия `review` с `fixFindings`, раз — по `reviewedAt` правок), а он —
 * только доставку группы с доставкой до MR (W3-3, зеркало Claude), одну на круг
 * (`deliveredAt`); после доставки не бывает ничего. Ревью — после КАЖДОЙ работы
 * (U6), и шедшей настройкой CLI тоже: свежая сессия — вторая пара глаз.
 */

/** Что панель запустит следующим звеном у чужого провайдера. */
export interface ForeignStagePlan {
  stage: 'work' | 'review' | 'fix' | 'deliver';
  /** Название нового разговора: человек находит звенья в списке по нему. */
  title: string;
  /** Задание звена — первой репликой нового разговора. */
  prompt: string;
  /**
   * Чем вести звено. Пусто у ревью, и это не пропуск: пустая модель означает
   * «без флагов», то есть настроенную модель самого CLI — единственное «выше»,
   * которое у чужого провайдера вообще есть.
   */
  model?: string;
  effort?: string;
  /** Шапка нового разговора. */
  cascade: ProviderChatCascade;
  /** Замечания, по которым заведены правки. */
  findings?: string[];
  /**
   * Работа заводится после плана, которого панель не получила (Т3). Не отказ:
   * уровень не блокирует, работа идёт по заданию группы — но сказать об этом в
   * ленте надо, иначе «план был» и «плана не было» выглядят одинаково.
   */
  planMissing?: boolean;
  /** Отчёт о ситах всех звеньев группы — в связь следующего (как у Claude). */
  sieveRows?: SieveReportRow[];
  /** Выжимка плана (у работы после плана) — в связь, звеньям после работы. */
  planSummary?: string;
  /**
   * Работа поднята с понижённой ступени на настройку CLI (F4): связь звена
   * не наследует ни модели, ни «ниже» остановившейся работы.
   */
  raised?: boolean;
}

export interface ForeignStageInput {
  /** Стадия закончившегося разговора; нет — это не звено конвейера. */
  cascade?: ProviderChatCascade;
  /** Прогон закончился успешно. После ошибки или остановки проверять нечего. */
  ok: boolean;
  /** Ответ целиком — в нём ищется блок вердикта ревью. */
  text: string;
  /** Задание закончившегося разговора: по нему ревьюер сверяет сделанное. */
  task: string;
  /** Изменила ли работа что-нибудь в копии; запуск git стоит дорого — вызываем последним. */
  hasWork: () => boolean;
  /**
   * Связь разговора. Нужна ровно плану (Т3): задание группы, её границы и
   * заметки разбора лежат там, а не в шапке — шапка держит НАЗНАЧЕНИЕ, а эти
   * поля у Claude и у чужого CLI одни и те же, и второй их копии быть не должно.
   */
  link?: ChatLink;
  /**
   * Ход кончился вопросом человеку (Д3): работа не закончена, и ревью по ней
   * было бы проверкой недоделанного.
   */
  paused?: boolean;
  /** Группа доводит работу до MR: за правками и чистым ревью — доставка (W3-3). */
  deliver?: boolean;
  /** Человек сам попросил доставить снова — отметка `deliveredAt` не держит. */
  redeliver?: boolean;
  /**
   * Абзац сит перед MR (решение владельца 28.09) — тот же, что у Claude: по
   * затронутым путям копии, выученным ситам и уже сданным строкам.
   */
  sieves?: (stage: SieveStage, done: readonly SieveReportRow[]) => string;
}

const STAGE_WORDS: Record<ForeignStagePlan['stage'], string> = {
  work: 'работа',
  review: 'ревью',
  fix: 'правки',
  deliver: 'доставка',
};

/** Название звена: от названия ГРУППЫ, а не предыдущего звена. */
function stageTitle(cascade: ProviderChatCascade, stage: ForeignStagePlan['stage']): string {
  const base = cascade.group?.trim() || cascade.branch?.trim() || 'Группа';
  return `${base} · ${STAGE_WORDS[stage]}`;
}

/**
 * Звено ДОСТАВКИ у чужого CLI (W3-3) — то же, что у Claude: на модели работы,
 * одно на круг. Задание без инструмента вопросов: у чужого CLI его нет, и
 * вопрос человеку — ход, кончившийся вопросом. Младшую ступень лестницы при
 * рычаге «Доставка на Sonnet» подставляет планировщик (`withForeignCheapDeliver`):
 * здесь ни провайдера, ни каталога моделей нет.
 */
function foreignDeliverPlan(
  cascade: ProviderChatCascade,
  input: ForeignStageInput,
  after: 'fix' | 'verify' | 'review' | 'work',
  sieveRows: SieveReportRow[],
  context: StageContext,
  /** Итог прохода проверки (U6): что осталось открытым или что он не отчитался. */
  verification?: { open?: string[]; unverified?: boolean },
): ForeignStagePlan | undefined {
  if (!input.deliver) return undefined;
  if (cascade.deliveredAt && !input.redeliver) return undefined;
  const model = cascade.workModel;
  const sieves = input.sieves?.('deliver', sieveRows);
  return {
    stage: 'deliver',
    title: stageTitle(cascade, 'deliver'),
    prompt: deliverStagePrompt({
      after,
      foreign: true,
      ...(cascade.branch ? { branch: cascade.branch } : {}),
      context,
      ...(sieves ? { sieves } : {}),
      ...(verification?.open?.length ? { open: verification.open } : {}),
      ...(verification?.unverified ? { unverified: true } : {}),
    }),
    ...(sieveRows.length > 0 ? { sieveRows } : {}),
    ...(model ? { model } : {}),
    ...(cascade.workEffort ? { effort: cascade.workEffort } : {}),
    cascade: {
      stage: 'deliver',
      ...(cascade.group ? { group: cascade.group } : {}),
      ...(cascade.branch ? { branch: cascade.branch } : {}),
      ...(cascade.kind ? { kind: cascade.kind } : {}),
      ...(model ? { workModel: model } : {}),
      ...(cascade.workEffort ? { workEffort: cascade.workEffort } : {}),
    },
  };
}

/**
 * План группы кончился — заводится РАБОТА (Т3, зеркало `ChatCascadeStages`).
 *
 * Единственное звено, которое стартует и после неудачного прогона: уровень не
 * блокирует. Одноразово по `plannedAt`: второе сообщение человека в чат плана
 * без отметки заводило бы вторую работу той же группы.
 *
 * Назначение работы лежит в шапке плана (`workModel`/`workEffort`/`lowered`) —
 * план шёл на потолке, то есть без флага модели, и чем вести работу, знает
 * только запись разделения. Задание и границы — в связи: они одни и те же у
 * обоих провайдеров.
 */
function afterForeignPlan(
  cascade: ProviderChatCascade,
  link: ChatLink | undefined,
  ok: boolean,
  text: string,
): ForeignStagePlan | undefined {
  if (cascade.plannedAt) return undefined;
  const model = cascade.workModel;
  if (!model) return undefined;

  const plan = ok ? scanPlanBlocks(text).plan : undefined;
  const kind = cascade.kind as TaskKind | undefined;
  const task = labelledCut(link?.task ?? '', TASK_MAX_CHARS);

  return {
    stage: 'work',
    title: stageTitle(cascade, 'work'),
    prompt: workAfterPlanPrompt({
      task,
      ...(link?.owns && link.owns.length > 0 ? { owns: link.owns } : {}),
      ...(link?.notes ? { notes: link.notes } : {}),
      ...(plan ? { plan } : {}),
    }),
    model,
    ...(cascade.workEffort ? { effort: cascade.workEffort } : {}),
    ...(plan ? { planSummary: labelledCut(plan, TASK_MAX_CHARS) } : { planMissing: true }),
    cascade: {
      stage: 'work',
      ...(cascade.group ? { group: cascade.group } : {}),
      ...(cascade.branch ? { branch: cascade.branch } : {}),
      ...(kind ? { kind } : {}),
      // «Ниже настройки CLI» на шапке плана значило «работа пойдёт ниже»; здесь
      // это становится тем, что оплачивается ревью.
      ...(cascade.lowered ? { lowered: true } : {}),
      workModel: model,
      ...(cascade.workEffort ? { workEffort: cascade.workEffort } : {}),
    },
  };
}

/**
 * Понижённая работа кончилась без единой правки — заново на настройке CLI
 * (F4, 12.10.2026), то есть без флага модели: выше у чужого CLI ничего нет.
 * Зеркало `raisedPlan` у Claude, одноразово по `plannedAt`.
 */
function raisedForeignPlan(
  cascade: ProviderChatCascade,
  input: ForeignStageInput,
): ForeignStagePlan | undefined {
  if (!cascade.lowered || cascade.plannedAt) return undefined;
  const link = input.link;
  return {
    stage: 'work',
    title: stageTitle(cascade, 'work'),
    prompt: raisedWorkPrompt({
      task: link?.task ?? input.task,
      ...(link?.owns && link.owns.length > 0 ? { owns: link.owns } : {}),
      ...(link?.notes ? { notes: link.notes } : {}),
      ...(link?.planSummary ? { plan: link.planSummary } : {}),
      report: input.text,
    }),
    raised: true,
    cascade: {
      stage: 'work',
      ...(cascade.group ? { group: cascade.group } : {}),
      ...(cascade.branch ? { branch: cascade.branch } : {}),
      ...(cascade.kind ? { kind: cascade.kind } : {}),
    },
  };
}

/**
 * Что запускать после этого разговора. `undefined` — цепочки нет или она
 * закрыта, и это самый частый ответ: обычные чаты чужих CLI сюда попадают все.
 */
export function planForeignStage(input: ForeignStageInput): ForeignStagePlan | undefined {
  const { cascade, ok, text, task, hasWork } = input;
  if (!cascade) return undefined;
  // Доставка — конец цепочки. Разбор (уровень 1) звеньев не заводит вовсе: его
  // итог применяет конвейер разделения, а не планировщик стадий.
  if (cascade.stage === 'deliver' || cascade.stage === 'triage') return undefined;
  // План — единственное звено, после которого следующее стартует и при неудаче.
  if (cascade.stage === 'plan') return afterForeignPlan(cascade, input.link, ok, text);
  if (!ok || input.paused) return undefined;
  // Отчёт о ситах едет по цепочке: сданное ревью доставка не повторяет.
  const sieveRows = mergeSieveRows(
    input.link?.sieveRows,
    stampSieveRows(scanSieveBlocks(text).rows, new Date().toISOString()),
  );
  const carried = sieveRows.length > 0 ? { sieveRows } : {};
  // Звено — новый разговор, и его первая реплика — промпт звена (F2, 12.10.2026):
  // задание группы, план и итог прошлого звена едут в него так же, как у Claude
  // (`stageContextOf`). Без них правки, проверка и доставка восстанавливали
  // задачу по диффу. Задание — слова группы без преамбул работы (TQ-01).
  const link = input.link;
  const groupTask =
    link?.groupTask ??
    link?.task ??
    (cascade.stage === 'work' && task.trim() ? labelledCut(task, TASK_MAX_CHARS) : undefined);
  const contextAfter = (previous: string): StageContext => ({
    ...(groupTask ? { task: groupTask } : {}),
    ...(link?.planSummary ? { plan: link.planSummary } : {}),
    ...(cascade.branch ? { branch: cascade.branch } : {}),
    ...(previous.trim()
      ? { previous: { stage: cascade.stage as CascadeStage, text: previous } }
      : {}),
  });
  // После правок — один проход проверки (U6), а не ревью второго круга. Уже
  // заведён — доставку заведёт он. Шапка правок до U6 замечаний не несёт — сразу
  // в доставку.
  if (cascade.stage === 'fix') {
    if (!cascade.fixFindings?.length) {
      return foreignDeliverPlan(cascade, input, 'fix', sieveRows, contextAfter(text));
    }
    if (cascade.reviewedAt) return undefined;
    return {
      stage: 'review',
      title: stageTitle(cascade, 'review'),
      prompt: verifyStagePrompt({
        findings: cascade.fixFindings,
        ...(cascade.branch ? { branch: cascade.branch } : {}),
        context: contextAfter(text),
      }),
      ...carried,
      // Ни модели, ни глубины: проверяет настройка CLI, как и ревью.
      cascade: {
        stage: 'review',
        ...(cascade.group ? { group: cascade.group } : {}),
        ...(cascade.branch ? { branch: cascade.branch } : {}),
        ...(cascade.kind ? { kind: cascade.kind } : {}),
        ...(cascade.workModel ? { workModel: cascade.workModel } : {}),
        ...(cascade.workEffort ? { workEffort: cascade.workEffort } : {}),
        fixFindings: cascade.fixFindings,
      },
    };
  }

  const kind = cascade.kind as TaskKind | undefined;
  const base: ProviderChatCascade = {
    stage: 'work',
    ...(cascade.group ? { group: cascade.group } : {}),
    ...(cascade.branch ? { branch: cascade.branch } : {}),
    ...(kind ? { kind } : {}),
  };

  if (cascade.stage === 'work') {
    // Ревью — после КАЖДОЙ работы (U6), и шедшей настройкой CLI тоже: та же
    // модель в свежей сессии читает дифф без истории его написания.
    // Ревью на работу заводится один раз. Без отметки второе сообщение человека
    // в тот же разговор заводило бы ещё одну проверку — и так на каждый ход.
    if (cascade.reviewedAt) return undefined;
    if (!hasWork()) return raisedForeignPlan(cascade, input);
    const sieves = input.sieves?.('review', sieveRows);

    return {
      stage: 'review',
      title: stageTitle(cascade, 'review'),
      prompt: reviewStagePrompt({
        task: groupTask ?? task,
        ...(cascade.workModel ? { model: cascade.workModel } : {}),
        ...(kind ? { kind } : {}),
        ...(cascade.branch ? { branch: cascade.branch } : {}),
        context: {
          ...(link?.planSummary ? { plan: link.planSummary } : {}),
          ...(text.trim() ? { previous: { stage: 'work', text } } : {}),
        },
        ...(sieves ? { sieves } : {}),
      }),
      ...carried,
      // Ни модели, ни глубины: это и есть «на потолке» для чужого CLI.
      cascade: {
        ...base,
        stage: 'review',
        // Чем шла работа — на неё вернутся правки, если замечания найдутся.
        ...(cascade.workModel ? { workModel: cascade.workModel } : {}),
        ...(cascade.workEffort ? { workEffort: cascade.workEffort } : {}),
      },
    };
  }

  // Проход проверки правок кончился (U6): правок он не заводит. Открытое и «не
  // отчитался» едут в доставку и в MR — молча доставить «всё исправлено» нельзя.
  if (cascade.fixFindings) {
    const verified = scanReviewBlocks(text);
    const open = verified.findings;
    return foreignDeliverPlan(
      cascade,
      input,
      'verify',
      sieveRows,
      contextAfter(verified.text),
      open ? { open } : { unverified: true },
    );
  }

  // Ревью закончилось. Блока нет вовсе — ревьюер не отчитался в понятном виде, и
  // заводить по такому ответу правки нельзя: человек прочтёт его текст сам.
  const reviewed = scanReviewBlocks(text);
  const findings = reviewed.findings;
  if (!findings) return undefined;
  // Замечаний нет — чинить нечего, а доставлять группе с доставкой есть что.
  if (findings.length === 0) {
    return foreignDeliverPlan(cascade, input, 'review', sieveRows, contextAfter(reviewed.text));
  }

  // Работа шла на потолке, то есть настройкой самого CLI (F3): правки идут ею
  // же — без модели и без «ниже настройки».
  const model = cascade.workModel;

  return {
    stage: 'fix',
    title: stageTitle(cascade, 'fix'),
    prompt: fixStagePrompt(findings, {
      ...(cascade.branch ? { branch: cascade.branch } : {}),
      reviewer: 'cli',
      // Как у Claude (RC-D-01): шапка правок — новый разговор без `deliveredAt`,
      // и за правками доставка придёт и после доставки круга — обещание верно.
      ...(input.deliver ? { deliver: true } : {}),
      verify: true,
      // Замечания уже в задании карточками — прозу ревью вокруг них правки не
      // получают (L2.2, как у Claude): до 24 тыс. знаков в каждом ходе правок.
      context: contextAfter(''),
    }),
    ...(model ? { model } : {}),
    ...(cascade.workEffort ? { effort: cascade.workEffort } : {}),
    findings,
    ...carried,
    cascade: {
      ...base,
      stage: 'fix',
      ...(model ? { workModel: model } : {}),
      ...(cascade.workEffort ? { workEffort: cascade.workEffort } : {}),
      // Правки идут ниже настройки CLI ровно так же, как работа: планка сдачи им
      // нужна та же самая. Ревью по ним не будет — будет один проход проверки (U6).
      ...(model ? { lowered: true } : {}),
      fixFindings: findings,
    },
  };
}

/**
 * Системная дописка звена: инициативы панели плюс планка сдачи там, где звено
 * идёт ниже настройки CLI.
 *
 * Копировать дописку закончившегося прогона нельзя: у работы в ней лежит
 * `loweredWorkPrompt` — «тебя ведёт модель ниже, проверь себя», — и, уехав в
 * ревью, эта строка сказала бы проверяющему обратное тому, зачем его завели.
 * Обещания ревью в правках нет: после них цепочка кончается.
 */
export function foreignStagePrefix(
  plan: ForeignStagePlan,
  settings: Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'>,
  childExtra?: string,
): string {
  return foreignChatPrefix(plan.cascade, settings, childExtra);
}

/**
 * Та же дописка, но по ШАПКЕ разговора, а не по плану звена.
 *
 * Нужна там, где прогон запускают заново для УЖЕ заведённого чата — продолжение
 * дерева после паузы (Т5). Собрать её копированием прошлого запуска нельзя:
 * дописка нигде не хранится, а собрать заново по стадии можно — стадия и
 * лежит в шапке. Ревью дописки не получает: оно идёт настройкой CLI, и «тебя
 * ведёт модель ниже» сказало бы проверяющему обратное тому, зачем его завели.
 */
export function foreignChatPrefix(
  cascade: ProviderChatCascade | undefined,
  settings: Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'>,
  /** Строки группы звена (`foreignChildExtra`): числа группы, эскалация у работы. */
  childExtra?: string,
): string {
  // Планку сдачи получают только те звенья, которые ИДУТ ниже настройки CLI:
  // работа и правки. Ревью идёт на потолке; разбор и план (Т3) — тоже, и
  // сказать плану «тебя ведёт модель ниже» значило бы соврать ему про самого
  // себя ровно там, где он решает, кому что поручать.
  const lowered =
    cascade?.lowered && (cascade.stage === 'work' || cascade.stage === 'fix') ? cascade : undefined;
  return [
    initiativePrompt(settings, { splitMuted: true, foreign: true }) ?? '',
    lowered
      ? loweredWorkPrompt(lowered.kind as TaskKind | undefined, {
          reviewer: 'cli',
          // Задание правок само называет проверки проекта (TQ-10).
          ...(lowered.stage === 'fix' ? { review: false, checksInTask: true } : {}),
          ...(lowered.stage === 'fix' && lowered.fixFindings?.length ? { verify: true } : {}),
        })
      : '',
    childExtra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Дописка продолжения чужого разговора в новой сессии. Шапка стадии ИЛИ связь
 * группы — это звено дерева: «без разделения» и строки группы, как на его
 * старте (дочерний не-план заводится без шапки, `split-launch.ts`). Ни того ни
 * другого — обычный разговор: ровно то, что получил бы новый чат того же CLI.
 */
export function foreignContinuationPrefix(
  header: ProviderChatCascade | undefined,
  settings: Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'>,
  child: { linked: boolean; extra?: string | undefined },
): string | undefined {
  if (header || child.linked) return foreignChatPrefix(header, settings, child.extra) || undefined;
  return initiativePrompt(settings, { foreign: true });
}

/** Разговор чужого CLI, у которого закончился ответ. */
export interface ForeignRunFinished {
  providerId: string;
  appDataDir: string;
  chatId: string;
  ok: boolean;
  /** Ответ целиком — в нём ищется блок вердикта ревью. */
  text: string;
  /** Момент старта прогона: по нему проверяется свежесть файла-опоры (Т7). */
  startedAt: number;
  /** Чем кончился упавший ход — уходит в итог группы (Д10). */
  error?: string;
  /** Надзор назначил повтор или попытки кончились (Д10) — см. `chainOutcomeOf`. */
  retry?: ChainOutcomeInput['retry'];
  /** Ход остановил человек (`ProviderChatFinished.stopped`): это не отказ модели. */
  stopped?: boolean;
}

/** Что планировщику нужно снаружи, чтобы завести звено. */
export interface ForeignStagePlannerDeps {
  /** Чаты провайдеров: ими же и запускается следующее звено. */
  chats: ProviderChatService;
  /** Провайдер по идентификатору; нет такого — звено не заводится. */
  provider: (providerId: string) => ConfigProvider | undefined;
  /** Каталог моделей провайдера — им разворачиваются алиасы в самом прогоне. */
  models: (provider: ConfigProvider) => ModelInfo[];
  /**
   * Настройки: из них собирается системная дописка звена; общий рычаг доставки
   * на младшей ступени — `groupEconomy.sonnetDeliver`.
   */
  settings: () => Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'> &
    Partial<Pick<AppSettings, 'groupEconomy'>>;
  /**
   * Выбор человека «Доставка на Sonnet» для группы связи (карточка разделения,
   * F-12) — тот же, что у Claude (`splitConveyor.sonnetDeliverOf`). Не задан —
   * дешёвой доставки нет вовсе: без него выбор «нет» у группы потерялся бы молча.
   */
  sonnetDeliverOf?: (link: ChatLink) => boolean | undefined;
  /**
   * Маршрут контура следующего прогона этого CLI: идёт ли он через контур и
   * какие имена переводит карта соответствия (`resolveRunRoute` для
   * `foreign:<cli>`). Дешёвая доставка через контур — только когда в карте есть
   * строка младшей ступени (то же правило, что у Claude, n6). Не задан — дешёвой
   * доставки нет: узнать, уедет ли младшая ступень в модель контура по
   * умолчанию, нечем, и доставка остаётся на модели работы.
   */
  contourRoute?: (providerId: string) => DeliverContourRoute;
  /**
   * Строки группы звена по ключу чата (`foreignChildExtra`) — те же, что у
   * ребёнка Claude. Не задан — звено идёт без них.
   */
  childExtra?: (chatKey: string) => string | undefined;
  /** Изменила ли работа что-нибудь в копии: пустой дифф проверять незачем. */
  hasWork: (cwd: string, since?: string) => boolean;
  /**
   * Свои шаги «Пути» группы звена после стадии (`runPathSteps`) — те же, что у
   * Claude. Не задан — шагов у чужого CLI нет.
   */
  pathSteps?: ForeignPathTurnDeps['pathSteps'];
  /**
   * Связи чатов. Звено наследует связь своего разговора — ту же группу, ту же
   * ветку, того же родителя, — меняя только стадию: без этого дерево видит одну
   * работу, а хаб родителя молчит о ревью и правках. Пусто — связей нет вовсе
   * (обычный чат, заведённый человеком).
   */
  linkOf?: (chatKey: string) => ChatLink | undefined;
  saveLink?: (chatKey: string, link: ChatLink) => void;
  /**
   * Ворота паузы дерева (Т5): стоящее дерево звеньев не запускает, а копит их в
   * очередь записи. Чат звена при этом заводится и связь пишется — иначе после
   * «Продолжить всё» запускать было бы нечего.
   */
  gate?: TreeStartGate;
  /**
   * Разбор (уровень 1, Т3) закончился: отдать его конвейеру разделения. Он
   * применит блок и заведёт порцию групп; обратно приходит строка для ленты —
   * что применено или чего не получилось. Не задан — разбора у чужого CLI нет,
   * и его разговор ведёт себя как обычный.
   */
  onTriage?: (input: { chatKey: string; ok: boolean; text: string }) => string | undefined;
  /**
   * Цепочка группы кончилась: звена больше не будет. Конвейер уровней отпускает
   * тех, кто её ждал (`after`), и сверяет ветки. План и разбор цепочкой не
   * считаются: за планом работа заводится всегда.
   */
  onChainEnded?: (link: ChatLink, outcome: ChainOutcome) => void;
  /** Группа связи доводит работу до MR — за правками идёт доставка (W3-3). */
  delivers?: (link: ChatLink) => boolean;
  /** Абзац сит для задания звена в копии `cwd` (как у Claude). Не задан — без сит. */
  sieves?: (
    cwd: string,
    link: ChatLink,
    stage: SieveStage,
    done: readonly SieveReportRow[],
  ) => Promise<string>;
  /**
   * Ревью чужого MR по ссылке (Т6) кончилось: замечания — в связь, решение —
   * человеку. Отвечает событием, которое лента чужого разговора показывает
   * строкой. Не задан — ревью по ссылкам в этой сборке нет, и группа ведёт
   * себя как обычная работа.
   */
  onReviewFinished?: (input: {
    chatId: string;
    aliases: string[];
    link: ChatLink;
    ok: boolean;
    text: string;
    paused?: boolean;
    hasWork?: () => boolean;
  }) => ChatEvent | undefined;
  /**
   * Память цепочек продолжения в чистой сессии (Т7) — ТА ЖЕ, что у Claude:
   * тумблер, номер шага и отпечаток файла-опоры общие, иначе «те же пределы»
   * у двух провайдеров оказались бы разными. Не задана — продолжений нет.
   */
  chains?: HandoffChains;
  /** Файловая система для предохранителей продолжения; подменяется в тестах. */
  stat?: StatFile;
  hash?: HashFile;
  /** Куда жаловаться: звено не должно ронять ответ, который уже записан. */
  onError?: (error: unknown) => void;
}

/**
 * Чем планировщик заводит продолжение. Домен продолжения (`handoff.ts`) не знает
 * ни провайдера, ни хранилища: разговор заводится и запускается вот этими двумя
 * колбэками — тем же приёмом, которым собран и сам планировщик.
 */
function foreignHandoffDeps(
  deps: ForeignStagePlannerDeps & { chains: HandoffChains },
  appDataDir: string,
  providerId: string,
): ForeignHandoffDeps {
  return {
    chains: deps.chains,
    open: (input) =>
      createChat(appDataDir, providerId, {
        title: input.title,
        workdir: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.cascade ? { cascade: input.cascade } : {}),
        ...(input.allowEdits === undefined ? {} : { allowEdits: input.allowEdits }),
      })?.id,
    run: (chatId, prompt, header) => {
      const provider = deps.provider(providerId);
      if (!provider) return;
      // Дописка собирается по стадии — той же функцией, что у звена. Стадии нет
      // (обычный разговор) — продолжение получает ровно то, что получил бы новый
      // чат того же CLI: инициативы панели и никакой планки сдачи.
      const key = foreignChatKey(providerId, chatId);
      const prefix = foreignContinuationPrefix(header, deps.settings(), {
        linked: Boolean(deps.linkOf?.(key)),
        extra: deps.childExtra?.(key),
      });
      deps.chats.send(
        appDataDir,
        providerId,
        chatId,
        { text: prompt },
        {
          provider,
          models: deps.models(provider),
          ...(prefix ? { systemPrefix: prefix } : {}),
        },
      );
    },
    ...(deps.saveLink ? { saveLink: deps.saveLink } : {}),
    ...(deps.gate ? { gate: deps.gate } : {}),
    ...(deps.stat ? { stat: deps.stat } : {}),
    ...(deps.hash ? { hash: deps.hash } : {}),
  };
}

/**
 * Доставка на младшей ступени упала отказом в модели (`workDeliverAfterRefusal`)
 * — та же доставка НОВЫМ разговором на модели работы. Новым, а не следующей
 * репликой: у чужого CLI история едет вместе с ходом, и упавший ход с текстом
 * отказа незачем показывать модели работы. Задание — первая реплика упавшего
 * разговора (сита в нём уже подставлены), шапка и связь — его же, без модели и
 * глубины младшей ступени. `true` — откат заведён, звеньев дальше не решаем.
 */
function redeliverOnWorkModel(
  deps: ForeignStagePlannerDeps,
  finished: ForeignRunFinished,
  chat: ProviderChatDetail,
  link: ChatLink,
): boolean {
  const { appDataDir, providerId, chatId } = finished;
  const provider = deps.provider(providerId);
  if (!provider) return false;
  const models = deps.models(provider);
  const cascade = readChatCascade(appDataDir, providerId, chatId);
  const work = workDeliverAfterRefusal(
    {
      cascade,
      chatModel: chat.model,
      ok: finished.ok,
      ...(finished.stopped ? { stopped: true } : {}),
      ...(finished.error ? { error: finished.error } : {}),
      ...(finished.retry ? { retry: finished.retry } : {}),
    },
    provider,
    models,
  );
  const prompt = chat.messages.find((message) => message.role === 'user')?.content;
  const cwd = chat.workdir;
  if (!work || !cascade || !prompt || !cwd) return false;

  const created = createChat(appDataDir, providerId, {
    title: chat.title,
    workdir: cwd,
    cascade,
    ...(work.model ? { model: work.model } : {}),
    ...(work.effort ? { effort: work.effort } : {}),
    ...(chat.allowEdits === undefined ? {} : { allowEdits: chat.allowEdits }),
  });
  if (!created) return false;

  const stageKey = foreignChatKey(providerId, created.id);
  const { model: _cheapModel, effort: _cheapEffort, ...carried } = link;
  deps.saveLink?.(stageKey, {
    ...carried,
    createdAt: new Date().toISOString(),
    ...(work.model ? { model: work.model } : {}),
    ...(work.effort ? { effort: work.effort } : {}),
  });
  // Упавшая доставка остаётся в ленте с текстом отказа — человек должен видеть,
  // куда она делась, а не гадать, откуда взялся второй разговор.
  appendMessage(appDataDir, providerId, chatId, {
    role: 'notice',
    content: `Модель «${chat.model}» эту доставку не приняла: аккаунт или маршрут её не пускают. Доставка заново — новым разговором на модели работы${work.model ? ` «${work.model}»` : ''}.`,
  });

  if (
    deps.gate?.defer(
      'stage',
      stageKey,
      { prompt, cwd } as RunOptions,
      {
        projectPath: cwd,
      } as RunMeta,
    )
  ) {
    return true;
  }
  const prefix = foreignChatPrefix(cascade, deps.settings(), deps.childExtra?.(stageKey));
  deps.chats.send(
    appDataDir,
    providerId,
    created.id,
    { text: prompt },
    { provider, models, ...(prefix ? { systemPrefix: prefix } : {}) },
  );
  return true;
}

/**
 * Следующий ход ТОГО ЖЕ разговора (шаг «Пути») с дополнением звена — тем же,
 * что на старте звена (`foreignChatPrefix`). `false` — не запустился.
 */
function sendInChat(
  deps: ForeignStagePlannerDeps,
  appDataDir: string,
  providerId: string,
  chatId: string,
  prompt: string,
): boolean {
  const provider = deps.provider(providerId);
  if (!provider) return false;
  const key = foreignChatKey(providerId, chatId);
  const prefix = foreignChatPrefix(
    readChatCascade(appDataDir, providerId, chatId),
    deps.settings(),
    deps.childExtra?.(key),
  );
  return deps.chats.send(
    appDataDir,
    providerId,
    chatId,
    { text: prompt },
    { provider, models: deps.models(provider), ...(prefix ? { systemPrefix: prefix } : {}) },
  ).ok;
}

/**
 * Слушатель завершения ответа: решает про звено и заводит его.
 *
 * Собирается снаружи (`bootstrap/runtime/runtime.ts`) тем же приёмом, что и планировщик
 * продолжения у Claude: домен принимает узкие колбэки, а не состояние панели.
 */
export function createForeignStagePlanner(
  deps: ForeignStagePlannerDeps,
): (finished: ForeignRunFinished) => Promise<void> {
  // Асинхронен ровно на одном шаге — абзаце сит; до него всё решается сразу.
  return async (finished) => {
    try {
      const { appDataDir, providerId, chatId } = finished;
      const chatKey = foreignChatKey(providerId, chatId);
      const link = deps.linkOf?.(chatKey);

      // Ревью чужого MR по ссылке (Т6) — не звено конвейера: после него панель
      // не заводит ничего, пока человек не нажмёт. Правки в чужой ветке и
      // запись в чужой MR автоматом не делаются никогда.
      //
      // Проверяется ДО шапки разговора, и это не порядок ради порядка: у
      // ревью-группы шапки нет вовсе — она идёт на потолке, то есть без
      // подобранной ступени, — и по шапке такой разговор от обычного не
      // отличить. Признак ревью один и живёт в связи.
      // Вопрос человеку текстом — пауза, а не итог (Д3). Фон чужого CLI панели
      // не виден: его ход кончается вместе с процессом.
      // Правило то же, что у итога группы (`waitsForAnswer`): иначе звено шло
      // за ходом, который `chainOutcomeOf` уже счёл вопросом.
      const paused = finished.ok && waitsForAnswer(finished.text);
      if (link?.review) {
        const reviewPath = link.review.path;
        const reviewWork = reviewPath ? () => deps.hasWork(reviewPath, link.createdAt) : undefined;
        const event = deps.onReviewFinished?.({
          chatId: chatKey,
          // Ключ у чужого разговора один: переносить связь на сессию, как у
          // Claude, тут не с чего — идентификатор выдаёт хранилище сразу.
          aliases: [chatKey],
          link,
          ok: finished.ok,
          text: finished.text,
          paused,
          ...(reviewWork ? { hasWork: reviewWork } : {}),
        });
        if (event?.kind === 'review') {
          appendMessage(appDataDir, providerId, chatId, {
            role: 'notice',
            content: reviewNoticeText(event),
          });
        }
        // Цепочка группы кончилась ровно здесь: следующего звена не будет, а
        // ждущие соседи (`after`) и сверка веток об этом узнать обязаны.
        // Связь перечитывается: ревью только что записало в неё свой итог.
        const current = deps.linkOf?.(chatKey) ?? link;
        deps.onChainEnded?.(
          current,
          chainOutcomeOf({
            link: current,
            ok: finished.ok,
            text: finished.text,
            ...(reviewWork ? { hasWork: reviewWork } : {}),
            ...(finished.error ? { error: finished.error } : {}),
            ...(finished.retry ? { retry: finished.retry } : {}),
          }),
        );
        return;
      }

      const cascade = readChatCascade(appDataDir, providerId, chatId);

      // Разбор (уровень 1) — не звено: его итог применяет конвейер разделения,
      // он же заводит группы. Проверяется первым, чтобы блок разделения в
      // ответе не искали как план работы.
      if (cascade?.stage === 'triage') {
        const notice = deps.onTriage?.({ chatKey, ok: finished.ok, text: finished.text });
        if (notice) {
          appendMessage(appDataDir, providerId, chatId, { role: 'notice', content: notice });
        }
        return;
      }

      const chat = readChat(appDataDir, providerId, chatId);
      if (!chat) return;

      // Младшую ступень доставки отвергли аккаунт или маршрут (C2) — доставка
      // заново на модели работы, а не провал группы без MR.
      if (
        link &&
        cascade?.stage === 'deliver' &&
        redeliverOnWorkModel(deps, finished, chat, link)
      ) {
        return;
      }

      // Задание разговора — ПЕРВАЯ реплика человека. Разделение кладёт туда
      // задание группы, и именно с ним ревьюер сверяет сделанное; последняя
      // реплика была бы уточнением по ходу работы, а не заданием.
      const firstTask = chat.messages.find((message) => message.role === 'user')?.content ?? '';

      // Свои шаги «Пути» группы идут ДО всего остального, как у Claude:
      // продолжение и звено решаются по ответу стадии, который шаги отложили.
      const pathed =
        link && chat.workdir && deps.pathSteps
          ? foreignPathTurn(
              {
                chatKey,
                link,
                cwd: chat.workdir,
                ok: finished.ok,
                paused,
                text: finished.text,
                task: firstTask,
                ...(finished.error ? { error: finished.error } : {}),
                ...(finished.retry ? { retry: finished.retry } : {}),
              },
              {
                pathSteps: deps.pathSteps,
                ...(deps.saveLink ? { saveLink: deps.saveLink } : {}),
                ...(deps.onChainEnded ? { onChainEnded: deps.onChainEnded } : {}),
                sendStep: (prompt) => sendInChat(deps, appDataDir, providerId, chatId, prompt),
              },
            )
          : { stop: false as const, text: finished.text, task: firstTask };
      if (pathed.stop) {
        if (pathed.notice) {
          appendMessage(appDataDir, providerId, chatId, { role: 'notice', content: pathed.notice });
        }
        return;
      }
      const { text, task } = pathed;

      // Продолжение в чистой сессии (Т7) — ДО звена конвейера и по той же
      // причине, что у Claude: предложение агента означает, что работа ещё идёт,
      // а проверять надо законченное. Спрашивается у любого разговора, а не
      // только у звена: слова «перезапусти сессию» человек читает в обычном чате
      // ровно так же, и предохранители у обоих одни.
      const continued = deps.chains
        ? planForeignHandoff(
            {
              providerId,
              chatId,
              ok: finished.ok,
              text,
              startedAt: finished.startedAt,
              title: chat.title,
              task,
              ...(chat.workdir ? { cwd: chat.workdir } : {}),
              ...(chat.model ? { model: chat.model } : {}),
              ...(chat.allowEdits === undefined ? {} : { allowEdits: chat.allowEdits }),
              ...(chat.effort ? { effort: chat.effort } : {}),
              ...(cascade ? { cascade } : {}),
              ...(link ? { link } : {}),
            },
            foreignHandoffDeps({ ...deps, chains: deps.chains }, appDataDir, providerId),
          )
        : undefined;
      if (continued?.notice) {
        appendMessage(appDataDir, providerId, chatId, {
          role: 'notice',
          content: continued.notice,
        });
      }
      // Продолжение заведено — звена не будет: работа не закончена, проверять
      // нечего. Ровно тот же порядок, что у планировщика Claude.
      if (continued?.chatId) return;

      // Дальше — только конвейер звеньев, а он бывает лишь у разговора со
      // стадией в шапке и с копией: ревью читает дифф, а без каталога его нет.
      if (!cascade || !chat.workdir) {
        // Связанный разговор без шапки (F3): звена не будет, но цепочка группы
        // кончилась, и ждущие соседи и сверка веток узнать об этом обязаны.
        // Новые группы шапку получают всегда — это сеть для старых и для
        // разговоров без копии.
        if (link && !cascade) {
          const workdir = chat.workdir;
          deps.onChainEnded?.(
            link,
            chainOutcomeOf({
              link,
              ok: finished.ok,
              text,
              ...(workdir ? { hasWork: () => deps.hasWork(workdir, chat.createdAt) } : {}),
              ...(finished.error ? { error: finished.error } : {}),
              ...(finished.retry ? { retry: finished.retry } : {}),
            }),
          );
        }
        return;
      }
      const cwd = chat.workdir;

      // Повтор доставки на тот же круг — только по ПОСЛЕДНЕЙ реплике человека:
      // она и завела этот ход (W3-3).
      const said = chat.messages.findLast((message) => message.role === 'user')?.content ?? '';
      // Абзац сит план получает меткой (см. `SIEVE_SLOT`): пути копии читаются
      // асинхронно, и подставляются перед запуском звена.
      let sieveAsk = undefined as SieveAsk | undefined;
      let plan = planForeignStage({
        cascade,
        ok: finished.ok,
        text,
        task,
        hasWork: () => deps.hasWork(cwd, chat.createdAt),
        ...(link ? { link } : {}),
        ...(paused ? { paused } : {}),
        ...(link?.parentChatId && deps.delivers?.(link) ? { deliver: true } : {}),
        ...(cascade.deliveredAt && asksDelivery(said) ? { redeliver: true } : {}),
        // Сита — только группе с доставкой: судит их отчёт она (ревью сит, 28.09).
        ...(link?.parentChatId && deps.delivers?.(link) && deps.sieves
          ? {
              sieves: (stage, done) => {
                sieveAsk = { stage, done };
                return SIEVE_SLOT;
              },
            }
          : {}),
      });
      if (!plan) {
        // Звена больше не будет — цепочка группы кончилась. План сюда не
        // попадает: за ним работа заводится всегда, а если не завелась, то
        // потому что уже была заведена (`plannedAt`).
        if (link && cascade.stage !== 'plan') {
          deps.onChainEnded?.(
            link,
            chainOutcomeOf({
              link,
              ok: finished.ok,
              text,
              hasWork: () => deps.hasWork(cwd, chat.createdAt),
              ...(finished.error ? { error: finished.error } : {}),
              ...(finished.retry ? { retry: finished.retry } : {}),
            }),
          );
        }
        return;
      }

      const provider = deps.provider(providerId);
      if (!provider) return;
      // Доставка на младшей ступени лестницы (C2): выбор группы сильнее общего рычага.
      if (
        plan.stage === 'deliver' &&
        link &&
        deps.sonnetDeliverOf &&
        deps.contourRoute &&
        resolveSonnetDeliver(
          deps.sonnetDeliverOf(link),
          deps.settings().groupEconomy?.sonnetDeliver,
        )
      ) {
        plan = withForeignCheapDeliver(
          plan,
          provider,
          deps.models(provider),
          deps.contourRoute(providerId),
        );
      }

      // Отметка «проверено» / «спланировано» — ДО запуска: упавший запуск не
      // повод завести вторую проверку или вторую работу той же группы на
      // следующем же сообщении человека.
      if (plan.stage === 'review') {
        setChatCascade(appDataDir, providerId, chatId, { reviewedAt: new Date().toISOString() });
      }
      if (plan.stage === 'deliver') {
        setChatCascade(appDataDir, providerId, chatId, { deliveredAt: new Date().toISOString() });
      }
      if (plan.stage === 'work') {
        setChatCascade(appDataDir, providerId, chatId, { plannedAt: new Date().toISOString() });
        // Уровень не блокирует, но и молчать о нём нельзя: без этой строки
        // «план был» и «плана не было» выглядят в ленте одинаково.
        if (plan.planMissing) {
          appendMessage(appDataDir, providerId, chatId, {
            role: 'notice',
            content: `План не получен (${finished.ok ? 'блока в ответе нет' : 'прогон не завершился'}) — работа идёт по заданию группы.`,
          });
        }
      }

      const created = createChat(appDataDir, providerId, {
        title: plan.title,
        workdir: cwd,
        cascade: plan.cascade,
        ...(plan.model ? { model: plan.model } : {}),
        ...(plan.effort ? { effort: plan.effort } : {}),
        // Звено идёт с правами разговора, который его завёл: ревью и правки
        // работы — та же работа, и переключатель человека действует на всю цепочку.
        ...(chat.allowEdits === undefined ? {} : { allowEdits: chat.allowEdits }),
      });
      if (!created) return;

      // Связь звена — до запуска и по тем же правилам, что у Claude: родитель и
      // группа те же, меняется стадия. Связи у разговора нет (не ребёнок
      // разделения) — звено остаётся вне дерева, как и сам разговор.
      const stageKey = foreignChatKey(providerId, created.id);
      if (link) {
        // Новое звено — своё окно работы (F-110), как у звеньев Claude (`base`).
        const carried = carriedStageLink(link);
        if (plan.raised) {
          delete carried.lowered;
          delete carried.model;
          delete carried.effort;
        }
        deps.saveLink?.(stageKey, {
          ...carried,
          stage: plan.stage,
          createdAt: new Date().toISOString(),
          ...(plan.model ? { model: plan.model } : {}),
          ...(plan.effort ? { effort: plan.effort } : {}),
          ...(plan.cascade.lowered ? { lowered: true } : {}),
          ...(plan.sieveRows ? { sieveRows: plan.sieveRows } : {}),
          ...(plan.planSummary ? { planSummary: plan.planSummary } : {}),
        });
      }

      const ask = sieveAsk;
      const prompt =
        ask && link && deps.sieves
          ? fillSieveSlot(
              plan.prompt,
              await deps.sieves(cwd, link, ask.stage, ask.done).catch(() => ''),
            )
          : plan.prompt;

      // Дерево стоит — звено заведено, но не запущено: старт лёг в очередь и
      // уйдёт по «Продолжить всё».
      if (
        deps.gate?.defer(
          'stage',
          stageKey,
          { prompt, cwd } as RunOptions,
          { projectPath: cwd } as RunMeta,
        )
      ) {
        return;
      }

      // Связь звена уже записана выше — дополнение читается по ней.
      const prefix = foreignStagePrefix(plan, deps.settings(), deps.childExtra?.(stageKey));
      const runDeps: ProviderChatRunDeps = {
        provider,
        models: deps.models(provider),
        ...(prefix ? { systemPrefix: prefix } : {}),
      };
      deps.chats.send(appDataDir, providerId, created.id, { text: prompt }, runDeps);
    } catch (error) {
      // Звено — надстройка над ответом, который уже записан в переписку. Упасть
      // здесь значит уронить обработчик завершения чужого прогона, а с ним и
      // рассылку по вкладкам.
      deps.onError?.(error);
    }
  };
}
