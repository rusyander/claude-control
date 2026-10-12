import type { AppSettings } from '@agentdeck/contracts';
import {
  deliverStagePrompt,
  fixStagePrompt,
  loweredWorkPrompt,
  reviewStagePrompt,
  scanReviewBlocks,
  verifyStagePrompt,
  type CascadeStage,
  type StageContext,
  type TaskKind,
} from '@agentdeck/contracts/model-cascade';
import { labelledCut, OWNER_TEXT_MAX } from '@agentdeck/contracts/quality-floor';
import {
  raisedWorkPrompt,
  scanPlanBlocks,
  workAfterPlanPrompt,
} from '@agentdeck/contracts/split-plan';
import {
  mergeSieveRows,
  scanSieveBlocks,
  type SieveReportRow,
  type SieveStage,
  stampSieveRows,
} from '@agentdeck/contracts/sieves';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';
import { initiativePrompt } from '../initiative/initiative.ts';

/**
 * Конвейер «работа → ревью → фикс → проверка» — решение о СЛЕДУЮЩЕМ звене.
 *
 * Зачем он вообще: вторая пара глаз. После успешной работы та же копия
 * читается моделью-потолком, а её замечания возвращаются исполнителю отдельным
 * заданием. С U6 — после КАЖДОЙ работы, не только понижённой: свежая сессия
 * видит дифф без истории его написания и на той же модели (раньше работа на
 * потолке шла без ревью, и «чисто» значило «никто не смотрел»). Ни одного лишнего ПАРАЛЛЕЛЬНОГО агента при этом не заводится —
 * звенья идут друг за другом в одной ветке, как продолжение в чистой сессии.
 *
 * Модуль намеренно ЧИСТЫЙ: ни файловой системы, ни реестра прогонов, ни
 * хранилища. Он отвечает на один вопрос — «что запускать дальше и с чем» — и
 * поэтому целиком проверяется тестами без единого настоящего прогона. Запуск,
 * запись связи и событие в ленту делает маршрут (`routes/chat/handoff-routes.ts`).
 *
 * Три вещи, которые здесь важнее всего и легко потерять при правке:
 *
 * 1. ЦЕПОЧКА КОНЕЧНА. Ревью заводится один раз на работу (`reviewedAt`), правки
 *    заводятся только по НЕПУСТОМУ списку замечаний, за правками — ОДИН проход
 *    проверки (`reviewedAt` связи правок), и его итог правок уже не заводит:
 *    открытое едет в доставку и в MR как открытое. Дальше бывает только
 *    доставка группы с доставкой до MR — одна на круг (`deliveredAt`), и
 *    после неё ничего. Иначе пара
 *    «проверил — поправил» крутилась бы, пока не упрётся в потолок цепочки
 *    продолжений, и подписку съела бы вежливость моделей.
 * 2. РЕВЬЮ ИДЁТ НА ПОТОЛКЕ ТОГО разговора, который завёл разделение, — он
 *    записан в связи. Пересчитать его к этому моменту нечем: половина потолка
 *    жила в шапке родительского чата, которого уже нет.
 * 3. ПРАВКИ ВОЗВРАЩАЮТСЯ НА МОДЕЛЬ РАБОТЫ. Список замечаний уже превратил
 *    неизвестное в понятное — платить за понятную правку потолком незачем.
 */

/** Что панель запустит следующим звеном. */
export interface CascadeStagePlan {
  stage: CascadeStage;
  /** Чем вести прогон звена. */
  model: string;
  effort: string;
  /** Задание звена — первым сообщением нового разговора. */
  prompt: string;
  /**
   * Связь нового чата: та же ветвь дерева, что и у работы, плюс стадия и обе
   * пары моделей. Пишется ДО запуска — иначе перенос ключа на настоящий
   * `sessionId` её не застанет (см. `SplitLink`).
   */
  link: ChatLink;
  /** Замечания, по которым заведены правки, — их показывает лента. */
  findings?: string[];
  /**
   * Работа стартует БЕЗ плана: прогон плана не дал блока, упал или был
   * остановлен (Т1). Уровень не блокирует, но лента обязана это назвать.
   */
  planMissing?: boolean;
}

export interface CascadeStageInput {
  /** Связь закончившегося чата; её отсутствие значит «это не ребёнок разделения». */
  link?: ChatLink;
  /** Прогон завершился успешно. После ошибки или остановки проверять нечего. */
  ok: boolean;
  /** Хвост ответа — в нём ищется блок вердикта ревью. */
  text: string;
  /** Задание закончившегося прогона: по нему ревьюер сверяет сделанное. */
  task: string;
  /**
   * Изменила ли работа хоть что-нибудь в копии. Функция, а не значение: ответ
   * стоит запуска git, а нужен он далеко не всегда — только когда всё остальное
   * уже сошлось.
   */
  hasWork: () => boolean;
  /**
   * Ход кончился паузой, а не итогом: вопросом человеку или с фоновой
   * командой, которая ещё идёт (Д3). Следующего звена тогда не заводим.
   */
  paused?: boolean;
  /**
   * Группа разделения доводит работу до MR (доставка включена на проекте). Тогда
   * за правками и за ревью без замечаний идёт звено доставки: без него группа
   * кончалась правками в грязной копии (журнал 59).
   */
  deliver?: boolean;
  /**
   * Человек сам попросил доставить снова (`asksDelivery` по его реплике). Без
   * этого второй доставки на тот же круг не бывает (`deliveredAt`, W3-3).
   */
  redeliver?: boolean;
  /**
   * Абзац сит перед MR для задания звена (`sievePromptBlock`): по затронутым
   * путям копии, выученным ситам и уже сданному отчёту. Функция, а не значение:
   * ответ стоит запуска git, а нужен только звеньям ревью и доставки.
   */
  sieves?: (stage: SieveStage, done: readonly SieveReportRow[]) => string;
  /** Часы — в тесте фиксируются. */
  now?: () => Date;
}

/**
 * Системная дописка звена: инициативы панели плюс планка сдачи там, где звено
 * идёт ниже потолка.
 *
 * Копировать дописку закончившегося прогона нельзя, и это главное здесь. У
 * работы в ней лежит `loweredWorkPrompt` — «тебя ведёт модель ниже потолка,
 * проверь себя»; уехав в ревью, эта строка сказала бы проверяющему ровно
 * обратное тому, зачем его завели. Поэтому дописка собирается заново по СТАДИИ.
 *
 * Разделение выключено у обоих звеньев: чат, выделенный под одну группу, делить
 * дальше некуда, а проверка чужой работы тем более.
 */
export function stageAppendPrompt(
  plan: Pick<CascadeStagePlan, 'stage' | 'link'>,
  settings: Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'>,
  /** Строки группы звена (`childStageExtra`): числа группы, эскалация у работы. */
  extra?: string,
): string {
  return [
    initiativePrompt(settings, { splitMuted: true }) ?? '',
    // Планка сдачи — да, обещание ревью — нет: после правок ревью не бывает
    // (разве что доставка), и склейка по умолчанию говорила исполнителю правок,
    // что панель заведёт проверку его диффа. Не заведёт ни разу. У доставки
    // планки нет вовсе: она не пишет код, который надо было бы сдавать.
    plan.stage === 'fix'
      ? loweredWorkPrompt(plan.link.kind as TaskKind | undefined, {
          review: false,
          // Задание правок само называет проверки проекта (TQ-10).
          checksInTask: true,
          ...(verifiesFixes(plan.link) ? { verify: true } : {}),
        })
      : // Работа после плана (Т1) — та же планка сдачи, что у работы, заведённой
        // разделением напрямую: понижение оплачивается ревью, и обещать его надо.
        plan.stage === 'work' && plan.link.lowered
        ? loweredWorkPrompt(plan.link.kind as TaskKind | undefined)
        : '',
    extra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * За правками этой связи панель заведёт проход проверки (U6): есть замечания и
 * есть кем проверять. Связи правок до U6 замечаний не несут — им проверки нет.
 */
function verifiesFixes(link: ChatLink): boolean {
  return Boolean(link.fixFindings?.length && link.ceilingModel);
}

/** Стадия связи; пусто читается как «работа»: так выглядят связи до конвейера. */
export function stageOf(link: ChatLink): CascadeStage {
  switch (link.stage) {
    case 'triage':
    case 'plan':
    case 'review':
    case 'fix':
    case 'deliver':
      return link.stage;
    default:
      return 'work';
  }
}

/**
 * Дописка следующего хода в чат группы — ответа человека, продолжения. Та же,
 * с которой звено запущено (`stageAppendPrompt` по стадии связи): иначе ход не
 * совпадал подписью с живым процессом звена и шёл холодным `--resume` (живой
 * прогон 25.09: ответ доходил до CLI через ~30 с), а ответ человека получал
 * инструкцию предложить разделение, которой у звена нет.
 */
export function childAppendPrompt(
  link: ChatLink,
  settings: Pick<AppSettings, 'taskSplitInitiative' | 'handoffInitiative'>,
  extra?: string,
): string {
  return stageAppendPrompt({ stage: stageOf(link), link }, settings, extra);
}

/**
 * Задание и план в связи звеньев. Раньше 16k и 4k с молчаливой обрезкой: ревью
 * сверяло работу с огрызком плана без критериев приёмки, а фикс и доставка
 * получали задание без хвоста. Теперь целиком; потолок — защита от мусора, и
 * обрезка подписана.
 */
const TASK_MAX = OWNER_TEXT_MAX;
const PLAN_SUMMARY_MAX = OWNER_TEXT_MAX;

/**
 * Контекст следующего звена (аудит 25.09, L238): задание группы, выжимка
 * плана, ветка и итог только что закончившегося звена. Чат группы
 * перенаправляется на звено, и без этого блока ревью, правки и доставка
 * начинали с нуля, восстанавливая задачу по диффу.
 */
function stageContextOf(
  link: ChatLink,
  task: string | undefined,
  previous: StageContext['previous'],
): StageContext {
  return {
    ...(task ? { task } : {}),
    ...(link.planSummary ? { plan: link.planSummary } : {}),
    ...(link.branch ? { branch: link.branch } : {}),
    ...(previous?.text.trim() ? { previous } : {}),
  };
}

/**
 * План группы кончился — заводится РАБОТА (Т1). Единственное звено, которое
 * стартует и после неудачного прогона: план не блокирует, а лента скажет, что
 * его не получили. Одноразово по `plannedAt`: второе сообщение человека в чат
 * плана без отметки заводило бы вторую работу.
 */
function afterPlan(
  link: ChatLink,
  ok: boolean,
  text: string,
  base: ChatLink,
  paused: boolean,
): CascadeStagePlan | undefined {
  if (link.plannedAt) return undefined;
  // План кончился вопросом человеку или ждёт фон — плана ещё нет: работа по
  // недописанному плану шла бы мимо ответа. Отметки `plannedAt` нет, и работу
  // заведёт тот ход чата плана, что кончится без паузы.
  if (paused) return undefined;
  const model = link.workModel ?? link.ceilingModel ?? link.model;
  if (!model) return undefined;
  const effort =
    link.workEffort ?? (link.workModel ? '' : (link.ceilingEffort ?? link.effort ?? ''));
  const plan = ok ? scanPlanBlocks(text).plan : undefined;
  const task = labelledCut(link.task ?? '', TASK_MAX);

  return {
    stage: 'work',
    model,
    effort,
    prompt: workAfterPlanPrompt({
      task,
      ...(link.owns ? { owns: link.owns } : {}),
      ...(link.notes ? { notes: link.notes } : {}),
      ...(plan ? { plan } : {}),
    }),
    ...(plan ? {} : { planMissing: true }),
    link: {
      ...base,
      stage: 'work',
      model,
      ...(effort ? { effort } : {}),
      // «Ниже потолка» на связи плана значило «работа пойдёт ниже»; здесь оно
      // становится тем, что читает ревью.
      ...(link.lowered ? { lowered: true } : {}),
      ...(task ? { task } : {}),
      ...(plan ? { planSummary: labelledCut(plan, PLAN_SUMMARY_MAX) } : {}),
      ...(link.owns ? { owns: link.owns } : {}),
      ...(link.notes ? { notes: link.notes } : {}),
    },
  };
}

/**
 * Понижённая работа кончилась без единой правки — работа идёт заново на
 * потолке (F4, 12.10.2026). Понижаются только механика, реализация и тесты: их
 * итог всегда дифф, и ход без правок — это остановка, которой планка сдачи и
 * обещает «продолжится на модели сильнее». Одноразово по `plannedAt`: тот же
 * знак, что держит работу после плана, — второе сообщение человека в этот чат
 * второго подъёма не заведёт.
 */
function raisedPlan(link: ChatLink, base: ChatLink, text: string): CascadeStagePlan | undefined {
  if (!link.lowered || link.plannedAt) return undefined;
  const model = link.ceilingModel;
  if (!model) return undefined;
  const effort = link.ceilingEffort;
  const task = link.task ?? link.groupTask ?? '';

  return {
    stage: 'work',
    model,
    effort: effort ?? '',
    prompt: raisedWorkPrompt({
      task,
      ...(link.owns ? { owns: link.owns } : {}),
      ...(link.notes ? { notes: link.notes } : {}),
      ...(link.planSummary ? { plan: link.planSummary } : {}),
      report: text,
    }),
    link: {
      ...base,
      stage: 'work',
      model,
      ...(effort ? { effort } : {}),
      ...(link.owns ? { owns: link.owns } : {}),
      ...(link.notes ? { notes: link.notes } : {}),
    },
  };
}

/**
 * Реплика человека просит доставку (W3-3): повелительное «доставь», «доведи до
 * MR», «перезапусти/повтори доставку», «deliver». Узко намеренно: задание
 * правок, напоминание панели о доставке и слова «доставка», «MR» в рассказе
 * повтором не считаются — иначе раз-на-круг снимался бы любым ходом.
 */
const ASKS_DELIVERY =
  /(?:^|[^\p{L}])(?:доставь|доставьте|доведи(?:те)?\s+до\s+(?:mr|мр)|(?:перезапусти|повтори)(?:те)?\s+доставку|deliver)(?:$|[^\p{L}])/iu;

export function asksDelivery(prompt: string): boolean {
  return ASKS_DELIVERY.test(prompt);
}

/**
 * Доставка на этот круг уже заведена (`deliveredAt`) и человек не просил снова —
 * второго звена нет (W3-3).
 */
function deliveredOnce(link: ChatLink, input: CascadeStageInput): boolean {
  return Boolean(link.deliveredAt) && !input.redeliver;
}

/** Класс работы, если он был распознан при подборе. */
function kindOf(link: ChatLink): TaskKind | undefined {
  return link.kind ? (link.kind as TaskKind) : undefined;
}

/**
 * Звено ДОСТАВКИ (журнал 59a): коммит, свежая основная, пуш своей ветки, MR.
 * Идёт на модели работы — доставка по навыку проекта не требует потолка, а
 * платить им за коммит и описание MR незачем. Ниже потолка по смыслу не
 * «понижена»: кода, который надо сдавать проверке, звено не пишет.
 */
function deliverPlan(
  link: ChatLink,
  base: ChatLink,
  after: 'fix' | 'verify' | 'review' | 'work',
  context: StageContext,
  sieves?: string,
  /** Итог прохода проверки (U6): что осталось открытым или что он не отчитался. */
  verification?: { open?: string[]; unverified?: boolean },
): CascadeStagePlan | undefined {
  const model = link.workModel ?? link.model;
  const effort = link.workEffort ?? link.effort;
  if (!model) return undefined;

  return {
    stage: 'deliver',
    model,
    effort: effort ?? '',
    prompt: deliverStagePrompt({
      after,
      ...(link.branch ? { branch: link.branch } : {}),
      context,
      ...(sieves ? { sieves } : {}),
      ...(verification?.open?.length ? { open: verification.open } : {}),
      ...(verification?.unverified ? { unverified: true } : {}),
    }),
    link: {
      ...base,
      stage: 'deliver',
      model,
      ...(effort ? { effort } : {}),
      ...(link.workModel ? { workModel: link.workModel } : {}),
      ...(link.workEffort ? { workEffort: link.workEffort } : {}),
    },
  };
}

/**
 * Что запускать после этого прогона. `undefined` — цепочка закрыта (или её и не
 * было), и это самый частый ответ: конвейер существует ради понижённых детей
 * разделения, а прогонов в панели идут сотни.
 */
export function planCascadeStage(input: CascadeStageInput): CascadeStagePlan | undefined {
  const { link, ok, text, task, hasWork, now = () => new Date() } = input;
  if (!link) return undefined;

  const stage = stageOf(link);
  // Доставка — конец цепочки. Разбор (уровень 1) звеньев не заводит вовсе: его
  // итог применяет конвейер разделения, а не планировщик стадий.
  if (stage === 'deliver' || stage === 'triage') return undefined;
  // Ревью чужого MR по ссылке (Т7) конвейеру не принадлежит: после него панель
  // не заводит ни правок, ни чего-либо ещё, пока человек не нажмёт кнопку.
  // Правки в чужой ветке и запись в чужой MR — не то, что делают автоматом.
  if (link.review) return undefined;

  const kind = kindOf(link);
  const sieveRows = mergeSieveRows(
    link.sieveRows,
    stampSieveRows(scanSieveBlocks(text).rows, new Date().toISOString()),
  );
  // Задание группы для звеньев после работы: слова группы без преамбул работы
  // (TQ-01); связь старше правки — собранное задание или промпт самой работы.
  const groupTask =
    link.groupTask ??
    link.task ??
    (stage === 'work' && task.trim() ? labelledCut(task, TASK_MAX) : undefined);
  const base: ChatLink = {
    parentChatId: link.parentChatId,
    createdAt: now().toISOString(),
    ...(link.title ? { title: link.title } : {}),
    ...(link.branch ? { branch: link.branch } : {}),
    ...(typeof link.groupIndex === 'number' ? { groupIndex: link.groupIndex } : {}),
    ...(kind ? { kind } : {}),
    ...(link.ceilingModel ? { ceilingModel: link.ceilingModel } : {}),
    ...(link.ceilingEffort ? { ceilingEffort: link.ceilingEffort } : {}),
    // Задание и план едут по всей цепочке (аудит 25.09, L238): звено после
    // звена иначе теряло их — у связи ревью задания уже не было.
    ...(link.task ? { task: link.task } : groupTask ? { task: groupTask } : {}),
    ...(link.groupTask ? { groupTask: link.groupTask } : {}),
    ...(link.planSummary ? { planSummary: link.planSummary } : {}),
    // Отчёт о ситах едет по цепочке: сделанное ревью доставка не повторяет, а
    // судья доставки видит строки всех звеньев.
    ...(sieveRows.length > 0 ? { sieveRows } : {}),
  };
  const sievesFor = (stage: SieveStage): string | undefined =>
    input.sieves?.(stage, sieveRows) || undefined;
  const contextAfter = (previousText: string): StageContext =>
    stageContextOf(link, groupTask, { stage, text: previousText });

  // План — единственное звено, после которого следующее стартует и при неудаче.
  if (stage === 'plan') return afterPlan(link, ok, text, base, Boolean(input.paused));
  if (!ok) return undefined;

  // Правки кончились. Ход, кончившийся вопросом или фоном, — не конец правок
  // (Д3): проверять и доставлять недоделанное рано.
  if (stage === 'fix') {
    if (input.paused) return undefined;
    // Один проход проверки (U6, deep-review §7): повтор доказательства каждого
    // замечания — «попытался» не значит «исправил». Ревью второго круга это не
    // заводит: итог проверки идёт в доставку. Уже заведена — доставку заведёт она.
    if (verifiesFixes(link)) {
      if (link.reviewedAt) return undefined;
      return verifyPlan(link, base, contextAfter(text));
    }
    // Связь правок до U6 (замечаний не несёт) — в доставку сразу (журнал 59a).
    return input.deliver && !deliveredOnce(link, input)
      ? deliverPlan(link, base, 'fix', contextAfter(text), sievesFor('deliver'))
      : undefined;
  }

  if (stage === 'work') {
    // Ход кончился вопросом человеку или ждёт фоновую команду — работа не
    // закончена (Д3): проверяющий читал бы недоделанное, пока сама работа
    // продолжается в той же копии. Ревью заведётся после того хода, что
    // кончится без паузы.
    if (input.paused) return undefined;
    // Ревью этой работе не будет вовсе — и доставку за ним ждать неоткуда: группа
    // с доставкой идёт в неё сразу (M8, журнал 59a). Раньше такая работа кончала
    // цепочку, и до MR её доводили только напоминания конвейера по фактам git.
    // Пустую работу не доставляем: MR без правок — не итог группы.
    const deliverNow = (): CascadeStagePlan | undefined =>
      input.deliver && !deliveredOnce(link, input) && hasWork()
        ? deliverPlan(link, base, 'work', contextAfter(text), sievesFor('deliver'))
        : undefined;
    // Ревью на работу заводится ровно один раз. Без отметки второе сообщение
    // человека в тот же чат заводило бы ещё одну проверку — и так на каждый ход.
    // Доставку этого круга заводит само ревью (или правки после него).
    if (link.reviewedAt) return undefined;
    // Ревью — после КАЖДОЙ работы (U6). Ревьюер — потолок разговора; работа,
    // шедшая на потолке без записанного потолка, читается своей же моделью в
    // свежей сессии. Понижённая работа без потолка — связь старше конвейера:
    // ревью «на чём придётся» слабее работы, а это не проверка.
    const reviewer = link.ceilingModel ?? (link.lowered ? undefined : link.model);
    if (!reviewer) return deliverNow();
    const reviewerEffort = link.ceilingModel
      ? link.ceilingEffort
      : link.lowered
        ? undefined
        : link.effort;
    if (!hasWork()) return raisedPlan(link, base, text);
    const reviewSieves = sievesFor('review');

    return {
      stage: 'review',
      model: reviewer,
      effort: reviewerEffort ?? '',
      prompt: reviewStagePrompt({
        task: groupTask ?? task,
        ...(link.model ? { model: link.model } : {}),
        ...(kind ? { kind } : {}),
        ...(link.branch ? { branch: link.branch } : {}),
        context: {
          ...(link.planSummary ? { plan: link.planSummary } : {}),
          ...(text.trim() ? { previous: { stage, text } } : {}),
        },
        ...(reviewSieves ? { sieves: reviewSieves } : {}),
      }),
      link: {
        ...base,
        stage: 'review',
        model: reviewer,
        ...(reviewerEffort ? { effort: reviewerEffort } : {}),
        // Ревьюер записан потолком связи: им же пойдёт проход проверки правок.
        ceilingModel: reviewer,
        ...(reviewerEffort ? { ceilingEffort: reviewerEffort } : {}),
        // Чем шла работа — на неё вернутся правки, если замечания найдутся.
        ...(link.model ? { workModel: link.model } : {}),
        ...(link.effort ? { workEffort: link.effort } : {}),
      },
    };
  }

  // Проход проверки правок кончился (U6): второго круга правок нет. Открытое и
  // «не отчитался» едут в доставку и в MR — молча доставить «всё исправлено»
  // нельзя. Без доставки итог остаётся в чате и на карточке группы.
  if (link.fixFindings) {
    if (input.paused || !input.deliver || deliveredOnce(link, input)) return undefined;
    const verified = scanReviewBlocks(text);
    return deliverPlan(
      link,
      base,
      'verify',
      contextAfter(verified.text),
      sievesFor('deliver'),
      verified.findings ? { open: verified.findings } : { unverified: true },
    );
  }

  // Ревью закончилось. Блока нет вовсе — ревьюер не отчитался в понятном виде, и
  // заводить по такому ответу правки нельзя: человек прочтёт его текст сам.
  const findings = scanReviewBlocks(text).findings;
  if (!findings) return undefined;
  // Замечаний нет — чинить нечего, но доставлять есть что: работа могла
  // рассчитывать на ревью и не довести ветку до MR.
  if (findings.length === 0) {
    return input.deliver && !input.paused && !deliveredOnce(link, input)
      ? deliverPlan(
          link,
          base,
          'review',
          contextAfter(scanReviewBlocks(text).text),
          sievesFor('deliver'),
        )
      : undefined;
  }

  const model = link.workModel ?? link.model;
  const effort = link.workEffort ?? link.effort;
  if (!model) return undefined;

  return {
    stage: 'fix',
    model,
    effort: effort ?? '',
    prompt: fixStagePrompt(findings, {
      ...(link.branch ? { branch: link.branch } : {}),
      ...(input.deliver ? { deliver: true } : {}),
      // Проход проверки будет, если есть кем проверять — ревьюер этой связи.
      ...(link.ceilingModel ? { verify: true } : {}),
      context: contextAfter(scanReviewBlocks(text).text),
    }),
    findings,
    link: {
      ...base,
      stage: 'fix',
      model,
      ...(effort ? { effort } : {}),
      ...(link.workModel ? { workModel: link.workModel } : {}),
      ...(link.workEffort ? { workEffort: link.workEffort } : {}),
      // Правки идут ниже потолка ровно так же, как работа: планка сдачи им нужна
      // та же самая. Ревью по ним не будет — будет один проход проверки (U6).
      lowered: true,
      fixFindings: findings,
    },
  };
}

/**
 * Проход ПРОВЕРКИ правок (U6): стадия `review` на ревьюере группы, но задание
 * другое — повтор доказательства каждого замечания, а не новое ревью. Связь
 * несёт те же замечания: по ним конец прохода отличается от конца ревью работы.
 */
function verifyPlan(
  link: ChatLink,
  base: ChatLink,
  context: StageContext,
): CascadeStagePlan | undefined {
  const model = link.ceilingModel;
  const findings = link.fixFindings;
  if (!model || !findings?.length) return undefined;
  const effort = link.ceilingEffort;

  return {
    stage: 'review',
    model,
    effort: effort ?? '',
    prompt: verifyStagePrompt({
      findings,
      ...(link.branch ? { branch: link.branch } : {}),
      context,
    }),
    link: {
      ...base,
      stage: 'review',
      model,
      ...(effort ? { effort } : {}),
      fixFindings: findings,
      ...(link.workModel ? { workModel: link.workModel } : {}),
      ...(link.workEffort ? { workEffort: link.workEffort } : {}),
    },
  };
}
