import type { AppSettings } from '@agentdeck/contracts';
import {
  deliverStagePrompt,
  fixStagePrompt,
  loweredWorkPrompt,
  reviewStagePrompt,
  scanReviewBlocks,
  type CascadeStage,
  type StageContext,
  type TaskKind,
} from '@agentdeck/contracts/model-cascade';
import { scanPlanBlocks, workAfterPlanPrompt } from '@agentdeck/contracts/split-plan';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { initiativePrompt } from './initiative.ts';

/**
 * Конвейер «работа → ревью → фикс» — решение о СЛЕДУЮЩЕМ звене.
 *
 * Зачем он вообще: панель отправила группу на модель ниже потолка, и это надо
 * чем-то оплатить. Плата — вторая пара глаз: после успешной работы та же копия
 * читается моделью-потолком, а её замечания возвращаются исполнителю отдельным
 * заданием. Ни одного лишнего ПАРАЛЛЕЛЬНОГО агента при этом не заводится —
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
 *    заводятся только по НЕПУСТОМУ списку замечаний, а после правок (и после
 *    работы, которой ревью не положено) бывает
 *    только доставка группы с доставкой до MR — одна на круг (`deliveredAt`), и
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
): string {
  return [
    initiativePrompt(settings, { splitMuted: true }) ?? '',
    // Планка сдачи — да, обещание ревью — нет: после правок ревью не бывает
    // (разве что доставка), и склейка по умолчанию говорила исполнителю правок,
    // что панель заведёт проверку его диффа. Не заведёт ни разу. У доставки
    // планки нет вовсе: она не пишет код, который надо было бы сдавать.
    plan.stage === 'fix'
      ? loweredWorkPrompt(plan.link.kind as TaskKind | undefined, { review: false })
      : // Работа после плана (Т1) — та же планка сдачи, что у работы, заведённой
        // разделением напрямую: понижение оплачивается ревью, и обещать его надо.
        plan.stage === 'work' && plan.link.lowered
        ? loweredWorkPrompt(plan.link.kind as TaskKind | undefined)
        : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Стадия связи; пусто читается как «работа»: так выглядят связи до конвейера. */
function stageOf(link: ChatLink): CascadeStage {
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
): string {
  return stageAppendPrompt({ stage: stageOf(link), link }, settings);
}

/** Знаков задания в связи: столько же, сколько хранит контракт плана. */
const TASK_MAX = 16_000;
/** Знаков плана в связи звеньев — выжимка для их задания, а не план целиком. */
const PLAN_SUMMARY_MAX = 4_000;

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
  const task = (link.task ?? '').slice(0, TASK_MAX);

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
      ...(plan ? { planSummary: plan.slice(0, PLAN_SUMMARY_MAX) } : {}),
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
  after: 'fix' | 'review' | 'work',
  context: StageContext,
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
  // Задание группы: записанное в связи (после плана) или промпт самой работы.
  const groupTask =
    link.task ?? (stage === 'work' && task.trim() ? task.slice(0, TASK_MAX) : undefined);
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
    ...(groupTask ? { task: groupTask } : {}),
    ...(link.planSummary ? { planSummary: link.planSummary } : {}),
  };
  const contextAfter = (previousText: string): StageContext =>
    stageContextOf(link, groupTask, { stage, text: previousText });

  // План — единственное звено, после которого следующее стартует и при неудаче.
  if (stage === 'plan') return afterPlan(link, ok, text, base, Boolean(input.paused));
  if (!ok) return undefined;

  // Правки кончились: ревью второго круга панель не заводит, а группа с
  // доставкой идёт в доставку (журнал 59a). Ход, кончившийся вопросом или
  // фоном, — не конец правок (Д3): доставлять недоделанное рано.
  if (stage === 'fix') {
    return input.deliver && !input.paused && !deliveredOnce(link, input)
      ? deliverPlan(link, base, 'fix', contextAfter(text))
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
        ? deliverPlan(link, base, 'work', contextAfter(text))
        : undefined;
    // Работа на потолке проверкой не усиливается: усиливать нечем.
    if (!link.lowered) return deliverNow();
    // Ревью на работу заводится ровно один раз. Без отметки второе сообщение
    // человека в тот же чат заводило бы ещё одну проверку — и так на каждый ход.
    // Доставку этого круга заводит само ревью (или правки после него).
    if (link.reviewedAt) return undefined;
    // Потолок не записан — связь старше конвейера. Завести ревью «на чём
    // придётся» нельзя: проверка слабее работы это не проверка.
    if (!link.ceilingModel) return deliverNow();
    if (!hasWork()) return undefined;

    return {
      stage: 'review',
      model: link.ceilingModel,
      effort: link.ceilingEffort ?? '',
      prompt: reviewStagePrompt({
        task: groupTask ?? task,
        ...(link.model ? { model: link.model } : {}),
        ...(kind ? { kind } : {}),
        ...(link.branch ? { branch: link.branch } : {}),
        context: {
          ...(link.planSummary ? { plan: link.planSummary } : {}),
          ...(text.trim() ? { previous: { stage, text } } : {}),
        },
      }),
      link: {
        ...base,
        stage: 'review',
        model: link.ceilingModel,
        ...(link.ceilingEffort ? { effort: link.ceilingEffort } : {}),
        // Чем шла работа — на неё вернутся правки, если замечания найдутся.
        ...(link.model ? { workModel: link.model } : {}),
        ...(link.effort ? { workEffort: link.effort } : {}),
      },
    };
  }

  // Ревью закончилось. Блока нет вовсе — ревьюер не отчитался в понятном виде, и
  // заводить по такому ответу правки нельзя: человек прочтёт его текст сам.
  const findings = scanReviewBlocks(text).findings;
  if (!findings) return undefined;
  // Замечаний нет — чинить нечего, но доставлять есть что: работа могла
  // рассчитывать на ревью и не довести ветку до MR.
  if (findings.length === 0) {
    return input.deliver && !input.paused && !deliveredOnce(link, input)
      ? deliverPlan(link, base, 'review', contextAfter(scanReviewBlocks(text).text))
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
      // та же самая, а вот ещё одного ревью по ним не будет — стадия конечна.
      lowered: true,
    },
  };
}
