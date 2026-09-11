import type { AppSettings, ModelInfo } from '@agentdeck/contracts';
import {
  fixStagePrompt,
  loweredWorkPrompt,
  reviewStagePrompt,
  scanReviewBlocks,
  type TaskKind,
} from '@agentdeck/contracts/model-cascade';
import {
  scanPlanBlocks,
  workAfterPlanPrompt,
  TASK_MAX_CHARS,
} from '@agentdeck/contracts/split-plan';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import type { ConfigProvider } from '../../providers/types.ts';
import type { RunOptions } from '../chat/ChatRunner.ts';
import type { RunMeta } from '../chat/ChatRunRegistry.ts';
import type { ChatEvent } from '../chat/chat-events.ts';
import type { TreeStartGate } from '../chat/tree-pause.ts';
import { initiativePrompt } from '../chat/initiative.ts';
import { reviewNoticeText } from '../chat/split-review.ts';
import type { HandoffChains, HashFile, StatFile } from '../chat/ChatHandoff.ts';
import { planForeignHandoff, type ForeignHandoffDeps } from './handoff.ts';
import { appendMessage, createChat, readChat, readChatCascade, setChatCascade } from './store.ts';
import type { ProviderChatCascade } from './store.ts';
import type { ProviderChatRunDeps, ProviderChatService } from './ProviderChatService.ts';

/**
 * Конвейер «работа → ревью → правки» у ЧУЖОГО CLI.
 *
 * Тот же смысл, что у Claude (`domains/chat/ChatCascadeStages.ts`): панель
 * отправила группу на модель ниже — плата за это вторая пара глаз. Разница одна,
 * зато определяющая: у чужого провайдера ПОТОЛКА НЕТ. Панель не знает, чем
 * настроен CLI, и умеет только понижать относительно этой настройки (см.
 * `domains/provider-cascade.ts`). Поэтому ревью здесь — это прогон БЕЗ подобранной
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
 * `fix` только по НЕПУСТОМУ списку замечаний, а после `fix` не бывает ничего.
 */

/** Что панель запустит следующим звеном у чужого провайдера. */
export interface ForeignStagePlan {
  stage: 'work' | 'review' | 'fix';
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
}

/** Название звена: от названия ГРУППЫ, а не предыдущего звена. */
function stageTitle(cascade: ProviderChatCascade, stage: ForeignStagePlan['stage']): string {
  const base = cascade.group?.trim() || cascade.branch?.trim() || 'Группа';
  const word = stage === 'review' ? 'ревью' : stage === 'fix' ? 'правки' : 'работа';
  return `${base} · ${word}`;
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
  const task = (link?.task ?? '').slice(0, TASK_MAX_CHARS);

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
    ...(plan ? {} : { planMissing: true }),
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
 * Что запускать после этого разговора. `undefined` — цепочки нет или она
 * закрыта, и это самый частый ответ: обычные чаты чужих CLI сюда попадают все.
 */
export function planForeignStage(input: ForeignStageInput): ForeignStagePlan | undefined {
  const { cascade, ok, text, task, hasWork } = input;
  if (!cascade) return undefined;
  // Правки — конец цепочки: ревью второго круга панель не заводит. Разбор
  // (уровень 1) звеньев не заводит вовсе: его итог применяет конвейер
  // разделения, а не планировщик стадий.
  if (cascade.stage === 'fix' || cascade.stage === 'triage') return undefined;
  // План — единственное звено, после которого следующее стартует и при неудаче.
  if (cascade.stage === 'plan') return afterForeignPlan(cascade, input.link, ok, text);
  if (!ok) return undefined;

  const kind = cascade.kind as TaskKind | undefined;
  const base: ProviderChatCascade = {
    stage: 'work',
    ...(cascade.group ? { group: cascade.group } : {}),
    ...(cascade.branch ? { branch: cascade.branch } : {}),
    ...(kind ? { kind } : {}),
  };

  if (cascade.stage === 'work') {
    // Работа шла настройкой CLI — усиливать нечем: ревью пошло бы ровно тем же.
    if (!cascade.lowered) return undefined;
    // Ревью на работу заводится один раз. Без отметки второе сообщение человека
    // в тот же разговор заводило бы ещё одну проверку — и так на каждый ход.
    if (cascade.reviewedAt) return undefined;
    if (!hasWork()) return undefined;

    return {
      stage: 'review',
      title: stageTitle(cascade, 'review'),
      prompt: reviewStagePrompt({
        task,
        ...(cascade.workModel ? { model: cascade.workModel } : {}),
        ...(kind ? { kind } : {}),
        ...(cascade.branch ? { branch: cascade.branch } : {}),
      }),
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

  // Ревью закончилось. Блока нет вовсе — ревьюер не отчитался в понятном виде, и
  // заводить по такому ответу правки нельзя: человек прочтёт его текст сам.
  const findings = scanReviewBlocks(text).findings;
  if (!findings || findings.length === 0) return undefined;

  const model = cascade.workModel;
  if (!model) return undefined;

  return {
    stage: 'fix',
    title: stageTitle(cascade, 'fix'),
    prompt: fixStagePrompt(findings, {
      ...(cascade.branch ? { branch: cascade.branch } : {}),
      reviewer: 'cli',
    }),
    model,
    ...(cascade.workEffort ? { effort: cascade.workEffort } : {}),
    findings,
    cascade: {
      ...base,
      stage: 'fix',
      workModel: model,
      ...(cascade.workEffort ? { workEffort: cascade.workEffort } : {}),
      // Правки идут ниже настройки CLI ровно так же, как работа: планка сдачи им
      // нужна та же самая, а вот ещё одного ревью по ним не будет — стадия конечна.
      lowered: true,
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
): string {
  return foreignChatPrefix(plan.cascade, settings);
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
          ...(lowered.stage === 'fix' ? { review: false } : {}),
        })
      : '',
  ]
    .filter(Boolean)
    .join(' ');
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
}

/** Что планировщику нужно снаружи, чтобы завести звено. */
export interface ForeignStagePlannerDeps {
  /** Чаты провайдеров: ими же и запускается следующее звено. */
  chats: ProviderChatService;
  /** Провайдер по идентификатору; нет такого — звено не заводится. */
  provider: (providerId: string) => ConfigProvider | undefined;
  /** Каталог моделей провайдера — им разворачиваются алиасы в самом прогоне. */
  models: (provider: ConfigProvider) => ModelInfo[];
  /** Настройки: из них собирается системная дописка звена. */
  settings: () => Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'>;
  /** Изменила ли работа что-нибудь в копии: пустой дифф проверять незачем. */
  hasWork: (cwd: string, since?: string) => boolean;
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
  onChainEnded?: (link: ChatLink, ok: boolean) => void;
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
      })?.id,
    run: (chatId, prompt, header) => {
      const provider = deps.provider(providerId);
      if (!provider) return;
      // Дописка собирается по стадии — той же функцией, что у звена. Стадии нет
      // (обычный разговор) — продолжение получает ровно то, что получил бы новый
      // чат того же CLI: инициативы панели и никакой планки сдачи.
      const prefix = header
        ? foreignChatPrefix(header, deps.settings())
        : initiativePrompt(deps.settings(), { foreign: true });
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
 * Слушатель завершения ответа: решает про звено и заводит его.
 *
 * Собирается снаружи (`bootstrap/runtime.ts`) тем же приёмом, что и планировщик
 * продолжения у Claude: домен принимает узкие колбэки, а не состояние панели.
 */
export function createForeignStagePlanner(
  deps: ForeignStagePlannerDeps,
): (finished: ForeignRunFinished) => void {
  return (finished) => {
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
      if (link?.review) {
        const event = deps.onReviewFinished?.({
          chatId: chatKey,
          // Ключ у чужого разговора один: переносить связь на сессию, как у
          // Claude, тут не с чего — идентификатор выдаёт хранилище сразу.
          aliases: [chatKey],
          link,
          ok: finished.ok,
          text: finished.text,
        });
        if (event?.kind === 'review') {
          appendMessage(appDataDir, providerId, chatId, {
            role: 'notice',
            content: reviewNoticeText(event),
          });
        }
        // Цепочка группы кончилась ровно здесь: следующего звена не будет, а
        // ждущие соседи (`after`) и сверка веток об этом узнать обязаны.
        deps.onChainEnded?.(link, finished.ok);
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

      // Задание разговора — ПЕРВАЯ реплика человека. Разделение кладёт туда
      // задание группы, и именно с ним ревьюер сверяет сделанное; последняя
      // реплика была бы уточнением по ходу работы, а не заданием.
      const task = chat.messages.find((message) => message.role === 'user')?.content ?? '';

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
              text: finished.text,
              startedAt: finished.startedAt,
              title: chat.title,
              task,
              ...(chat.workdir ? { cwd: chat.workdir } : {}),
              ...(chat.model ? { model: chat.model } : {}),
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
      if (!cascade) return;
      if (!chat.workdir) return;
      const cwd = chat.workdir;

      const plan = planForeignStage({
        cascade,
        ok: finished.ok,
        text: finished.text,
        task,
        hasWork: () => deps.hasWork(cwd, chat.createdAt),
        ...(link ? { link } : {}),
      });
      if (!plan) {
        // Звена больше не будет — цепочка группы кончилась. План сюда не
        // попадает: за ним работа заводится всегда, а если не завелась, то
        // потому что уже была заведена (`plannedAt`).
        if (link && cascade.stage !== 'plan') deps.onChainEnded?.(link, finished.ok);
        return;
      }

      const provider = deps.provider(providerId);
      if (!provider) return;

      // Отметка «проверено» / «спланировано» — ДО запуска: упавший запуск не
      // повод завести вторую проверку или вторую работу той же группы на
      // следующем же сообщении человека.
      if (plan.stage === 'review') {
        setChatCascade(appDataDir, providerId, chatId, { reviewedAt: new Date().toISOString() });
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
      });
      if (!created) return;

      // Связь звена — до запуска и по тем же правилам, что у Claude: родитель и
      // группа те же, меняется стадия. Связи у разговора нет (не ребёнок
      // разделения) — звено остаётся вне дерева, как и сам разговор.
      const stageKey = foreignChatKey(providerId, created.id);
      if (link) {
        deps.saveLink?.(stageKey, {
          ...link,
          stage: plan.stage,
          createdAt: new Date().toISOString(),
          ...(plan.model ? { model: plan.model } : {}),
          ...(plan.effort ? { effort: plan.effort } : {}),
          ...(plan.cascade.lowered ? { lowered: true } : {}),
        });
      }

      // Дерево стоит — звено заведено, но не запущено: старт лёг в очередь и
      // уйдёт по «Продолжить всё».
      if (
        deps.gate?.defer(
          'stage',
          stageKey,
          { prompt: plan.prompt, cwd } as RunOptions,
          { projectPath: cwd } as RunMeta,
        )
      ) {
        return;
      }

      const prefix = foreignStagePrefix(plan, deps.settings());
      const runDeps: ProviderChatRunDeps = {
        provider,
        models: deps.models(provider),
        ...(prefix ? { systemPrefix: prefix } : {}),
      };
      deps.chats.send(appDataDir, providerId, created.id, { text: plan.prompt }, runDeps);
    } catch (error) {
      // Звено — надстройка над ответом, который уже записан в переписку. Упасть
      // здесь значит уронить обработчик завершения чужого прогона, а с ним и
      // рассылку по вкладкам.
      deps.onError?.(error);
    }
  };
}
