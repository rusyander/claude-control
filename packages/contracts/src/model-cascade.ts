import { blockLang, blockLangPattern } from './brand.ts';
/**
 * Подбор модели под задачу: какой моделью и с какой глубиной пойдёт каждый
 * ребёнок разделения задач.
 *
 * Смысл: человек один раз задаёт ПОТОЛОК — это уже существующие
 * `chatModel`/`chatEffort` (настройки панели плюс оверрайд в шапке чата), ничего
 * нового вводить не надо. Ниже потолка панель опускается сама, но не «как решит
 * модель»: модель плохо выбирает модель («мне хватит sonnet» — это оценка себя,
 * а не задачи) и неплохо называет РОД работы. Поэтому агент КЛАССИФИЦИРУЕТ
 * группу, а модель и глубину под класс подставляет таблица в коде — её видно,
 * её правят одной строкой, и она одинакова для всех прогонов.
 *
 * Три вещи панель обязана гарантировать кодом: не выше потолка, никогда `max`,
 * никогда устаревшее поколение. Последнее исключено ПО ПОСТРОЕНИЮ: назначать
 * можно только алиасы CLI (`haiku`/`sonnet`/`opus`/`fable`), а алиас
 * разворачивается в последнюю модель семейства сам. Конкретный id из ответа
 * агента не принимается вовсе — иначе первая же модель, «вспомнившая» имя
 * прошлогодней версии, увела бы туда целую группу, и никто бы не заметил.
 *
 * Четвёртая гарантия не здесь, но ради неё всё и затевалось: понижение
 * оплачивается проверкой. Плата состоит из двух частей. Первая — планка сдачи:
 * группа, поехавшая ниже потолка, помечается (`lowered`) и получает
 * `loweredWorkPrompt` — обязанность прогнать проверки проекта и право
 * остановиться, упёршись в чужой класс. Вторая — конвейер звеньев: после
 * успешной работы панель сама заводит РЕВЬЮ НА ПОТОЛКЕ в той же копии
 * (`reviewStagePrompt`), а по его замечаниям — правки обратно на модели работы
 * (`fixStagePrompt`). «Дешёвая модель делает, дорогая проверяет» — ровно это, и
 * теперь об этом можно говорить и человеку, и агенту.
 *
 * Модуль намеренно САМОДОСТАТОЧЕН и без zod (как `task-split`, `chat-handoff`,
 * `uploads`): его значения нужны и серверу, и вебу, а сервер работает без сборки
 * (`--experimental-strip-types`) и падает на импорте значения из бочки
 * контрактов. Сабпаты друг друга не импортируют — это условие, а не стиль.
 */

/** Что можно назначить группе: только алиасы CLI, по возрастанию силы. */
export const ASSIGNABLE_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

export type AssignableModel = (typeof ASSIGNABLE_MODELS)[number];

/**
 * Лестница «кто сильнее». Составлена руками и меняется руками: в каталоге
 * models.dev ранга силы нет, а выводить его из цены или размера контекста —
 * гадание.
 */
export const MODEL_RANK: Readonly<Record<AssignableModel, number>> = {
  haiku: 1,
  sonnet: 2,
  opus: 3,
  fable: 4,
};

/** Глубина продумывания, которую можно назначить. `max` в наборе ОТСУТСТВУЕТ. */
export const ASSIGNABLE_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

export type AssignableEffort = (typeof ASSIGNABLE_EFFORTS)[number];

export const EFFORT_RANK: Readonly<Record<AssignableEffort, number>> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
};

/**
 * Род работы в группе — единственное, что панель спрашивает у агента про
 * модель. Набор закрытый и короткий: чем длиннее список, тем чаще модель
 * выбирает из него наугад.
 */
export const TASK_KINDS = [
  'mechanical',
  'implementation',
  'tests',
  'investigation',
  'design',
  'review',
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

/** План класса: чего этой работе достаточно. */
export interface KindPlan {
  model: AssignableModel;
  effort: AssignableEffort;
}

/**
 * Таблица «класс → чем делать». `undefined` значит ПОТОЛОК: работа, которую
 * нельзя удешевлять, потому что цена ошибки в ней не видна сразу.
 *
 * `haiku` в таблице нет намеренно: автоматически он не назначается никогда —
 * только руками на карточке. Разница между haiku и sonnet на настоящей правке
 * кода стоит дороже сэкономленного окна, а понижать «на всякий случай» — ровно
 * тот риск, ради которого весь этот файл и написан.
 */
export const KIND_PLAN: Readonly<Record<TaskKind, KindPlan | undefined>> = {
  // Переименования, одна и та же правка во многих файлах, формат, переносы:
  // результат виден проверками проекта сразу и целиком.
  mechanical: { model: 'sonnet', effort: 'medium' },
  // Понятная правка или фича с готовыми критериями приёмки.
  implementation: { model: 'sonnet', effort: 'high' },
  // Тесты по готовой спецификации — та же понятная работа.
  tests: { model: 'sonnet', effort: 'high' },
  // Причина неизвестна: плавающий баг, производительность, разбор чужого кода.
  investigation: undefined,
  // Архитектура, контракты, миграции, безопасность — всё необратимое.
  design: undefined,
  // Проверка чужой работы: ради неё понижение и оплачивается.
  review: undefined,
};

/**
 * Факты, по которым панель поднимает ранг сама, не спрашивая модель: большая
 * группа механикой не бывает, сколько бы агент ни настаивал.
 */
const BIG_GROUP_TASKS = 5;
const BIG_GROUP_CHARS = 4_000;

/**
 * Группа, которую панель считает большой по одним только фактам — числу задач и
 * длине задания. Экспортируется, потому что тот же вопрос решает подбор у ЧУЖИХ
 * провайдеров (`domains/provider-cascade.ts`): у них другая лестница моделей, но
 * ровно та же поправка на размер, и второй её копии быть не должно.
 */
export function isBigGroup(group: Pick<CascadeGroup, 'tasks' | 'length'>): boolean {
  return (group.tasks ?? 0) >= BIG_GROUP_TASKS || (group.length ?? 0) > BIG_GROUP_CHARS;
}

/** Потолок прогона: то, что выбрал человек в настройках или в шапке чата. */
export interface CascadeCeiling {
  /** Алиас (`opus`) либо конкретное имя модели (`claude-opus-5`), либо пусто. */
  model: string;
  /** Уровень `--effort`, `max` или пусто (значение CLI по умолчанию). */
  effort: string;
}

/** Пожелание агента по группе — как пришло, без проверки. */
export interface CascadeAssignment {
  model?: string;
  effort?: string;
}

/** Что реально уходит в аргументы прогона после клэмпа. */
export interface CascadeChoice {
  model: string;
  effort: string;
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function assignableModel(value: string | undefined): AssignableModel | undefined {
  const name = normalize(value);
  return ASSIGNABLE_MODELS.find((model) => model === name);
}

function assignableEffort(value: string | undefined): AssignableEffort | undefined {
  const name = normalize(value);
  return ASSIGNABLE_EFFORTS.find((effort) => effort === name);
}

/**
 * Ранг потолка-модели. Потолок человек задаёт не только алиасом: в настройках
 * лежит и конкретное имя (`claude-opus-5`, иногда с суффиксом `[1m]`), поэтому
 * семейство ищется подстрокой. Совпало несколько — берём МЛАДШЕЕ: ошибиться в
 * сторону строгости безопасно, в обратную — значит поднять ребёнка выше
 * потолка.
 *
 * `undefined` — потолок не распознан (пустая строка, чужой вендор, незнакомое
 * имя). Это не ошибка: каскад для такого прогона просто выключается, дети едут
 * на самом потолке, как ехали до всей этой затеи.
 */
export function ceilingModelRank(ceiling: string): number | undefined {
  const name = normalize(ceiling);
  if (!name) return undefined;

  let rank: number | undefined;
  for (const model of ASSIGNABLE_MODELS) {
    if (!name.includes(model)) continue;
    const found = MODEL_RANK[model];
    if (rank === undefined || found < rank) rank = found;
  }
  return rank;
}

/**
 * Семейство, к которому относится значение модели: `claude-opus-5` → `opus`.
 *
 * Нужно там, где значение надо показать выбором из лестницы, — на карточке
 * разделения. Потолок человек задаёт и конкретным именем, а список замены
 * состоит из алиасов, и без обратного приведения выбранное значение просто не
 * нашлось бы в своём же списке.
 */
export function modelAlias(value: string): AssignableModel | undefined {
  const rank = ceilingModelRank(value);
  return rank === undefined ? undefined : ASSIGNABLE_MODELS[rank - 1];
}

/**
 * Ранг потолка-глубины. Пусто (`--effort` не передаётся) и `max` считаются
 * `xhigh`: пустой потолок ничего не запрещает, а `max` — единственный уровень
 * выше `xhigh`, назначать который нельзя никому.
 */
export function ceilingEffortRank(ceiling: string): number {
  return EFFORT_RANK[assignableEffort(ceiling) ?? 'xhigh'];
}

/**
 * Сам потолок в виде, пригодном для назначения: `max` превращается в `xhigh`,
 * незнакомое — в пустую строку (пусть решает CLI). Именно это значение получает
 * группа, которой агент глубину не назначил.
 */
function ceilingEffortValue(ceiling: string): string {
  const value = normalize(ceiling);
  if (!value) return '';
  if (value === 'max') return 'xhigh';
  return assignableEffort(value) ?? '';
}

/**
 * Что можно предлагать при таком потолке — для инструкции агенту и для списка
 * выбора на карточке. Пустой список означает «каскад недоступен»: потолок не
 * распознан, и сравнивать не с чем.
 */
export function assignableModelsUpTo(ceiling: string): AssignableModel[] {
  const rank = ceilingModelRank(ceiling);
  return rank === undefined ? [] : ASSIGNABLE_MODELS.slice(0, rank);
}

export function assignableEffortsUpTo(ceiling: string): AssignableEffort[] {
  return ASSIGNABLE_EFFORTS.slice(0, ceilingEffortRank(ceiling));
}

/**
 * Клэмп: пожелание агента → значения, с которыми панель готова запустить прогон.
 *
 * Правила по обеим осям одинаковые по смыслу и разные в мелочи, и мелочь тут
 * существенная:
 *
 * - модель ниже потолка → уходит АЛИАС (последнее поколение семейства);
 * - модель равна потолку, выше потолка, вне набора или не названа → уходит САМ
 *   потолок как есть. Не алиас семейства: человек мог выбрать конкретное имя,
 *   и подменять его нам нечем и незачем;
 * - потолок не распознан → каскад по модели выключен, всё едет на потолке;
 * - глубина ведёт себя так же, но `max` не возвращается НИКОГДА: потолок `max`
 *   срезается до `xhigh` и здесь, потому что «никогда не назначать max» — это
 *   про любой прогон, который завела панель, а не только про тот, где агент
 *   что-то попросил.
 */
export function clampAssignment(
  assignment: CascadeAssignment | undefined,
  ceiling: CascadeCeiling,
): CascadeChoice {
  return {
    model: clampModel(assignment?.model, ceiling.model),
    effort: clampEffort(assignment?.effort, ceiling.effort),
  };
}

/**
 * Что панель говорит агенту про подбор — ОДНОЙ строкой, как и все инициативы
 * (на Windows аргумент уезжает через оболочку, и перевод строки внутри него
 * разрывает командную строку).
 *
 * Собирается функцией, а не лежит константой, потому что потолок динамический:
 * он меняется настройкой и оверрайдом в шапке чата, а называть агенту потолок
 * обязательно — иначе «подними, если сложнее» звучит как разрешение просить что
 * угодно.
 *
 * Просить у модели ИМЯ модели мы перестали намеренно: класс работы она называет
 * заметно устойчивее, чем выбирает себе исполнителя.
 */
export function cascadeSystemPrompt(ceiling: CascadeCeiling): string {
  const models = assignableModelsUpTo(ceiling.model);
  if (models.length === 0) return '';

  const top = ceiling.model || 'the default model';
  return (
    'The panel, not you, picks the model for each group: give every group the field kind — ' +
    'mechanical (renames, one edit repeated across many files, formatting, moves), ' +
    'implementation (a clear fix or feature with ready acceptance criteria), ' +
    'tests (tests against a ready specification), ' +
    'investigation (cause unknown: flaky bug, performance, reading unfamiliar code), ' +
    'design (architecture, contracts, migrations, security, anything irreversible), ' +
    'review (checking the work of someone else). ' +
    `The ceiling of this conversation is ${top}; nothing goes above it. ` +
    'If a group is harder than its class, add a higher model and effort to it ' +
    `(models: ${models.join(', ')}; effort: ${assignableEffortsUpTo(ceiling.effort).join(', ')}); ` +
    'a group cannot go below its class. ' +
    'Unsure about the class — omit kind entirely: such a group runs at the ceiling. ' +
    'For a group below the ceiling the panel itself raises the bar for done and, after its work, ' +
    `starts a review on ${top} over the same diff — nothing about that belongs in the task.`
  );
}

/**
 * Что дописывается прогону, который панель СОЗНАТЕЛЬНО отправила на модель ниже
 * потолка. Одной строкой, как и всё в этой склейке.
 *
 * Смысл не в предупреждении, а в двух обязательствах. Первое — планка сдачи:
 * работа, сделанная более слабой моделью, обязана быть проверена машиной, а не
 * ощущением. Второе — право остановиться: главный риск подбора в том, что класс
 * поставлен по формулировке задачи, а не по её настоящей сложности, и агент,
 * упёршийся в архитектуру там, где ждали механику, должен сказать это, а не
 * выкручиваться на том, что есть.
 *
 * Про ревью говорится прямо, и это не любезность: агент, знающий, что его работу
 * прочтёт модель сильнее, оставляет незаконченное незаконченным вместо
 * правдоподобного «готово». Скрывать проверку ради «чистоты эксперимента» здесь
 * нечего — проверка не ловушка, а следующее звено той же работы.
 */
export function loweredWorkPrompt(
  kind: TaskKind | undefined,
  options: {
    /**
     * Заведёт ли панель ревью этой работы. Ручной веер — единственное место, где
     * нет: он работает в настоящих каталогах проектов, своего диффа у него не
     * бывает, и обещание «панель сама заведёт ревью» было бы враньём в задании —
     * агент рассчитывал бы на вторую пару глаз, которой не будет.
     */
    review?: boolean;
    /**
     * Откуда взялась ступень и кто прочтёт работу. `ceiling` — потолок
     * разговора: он выбран человеком, и ревью пойдёт ровно на нём. `cli` — чужой
     * провайдер, у которого потолка НЕТ вовсе: панель умеет только понижать
     * относительно настройки самого CLI, поэтому и ревьюер там — эта настройка,
     * то есть ровно то, чем прогон шёл бы без панели. Обещать в этом случае
     * «модель сильнее» нельзя: чем настроен CLI, панель не знает.
     */
    reviewer?: 'ceiling' | 'cli';
  } = {},
): string {
  const named = kind ? `"${kind}"` : 'simple work';
  const review = options.review ?? true;
  const foreign = options.reviewer === 'cli';
  return (
    (foreign
      ? 'This work runs on a model BELOW the one the CLI uses by its own setting: ' +
        'the panel picked it by the kind of task. '
      : 'This work runs on a model BELOW the ceiling of the conversation: the panel picked it by ' +
        'the kind of task. ') +
    'Before you say "done", run the project checks (types, lint, tests — whatever it has) ' +
    'and compare what you did with the task point by point. ' +
    `If it turns out the task is harder than ${named} — decisions about architecture, ` +
    'contracts or migrations are needed, or the cause of a failure is unknown — do not improvise: ' +
    'describe what you hit and end the turn; the work continues on a stronger model. ' +
    'Call unfinished work unfinished: stopping with an honest list of what is left costs less ' +
    'than a plausible "done" followed by more fixes than there was work.' +
    (review
      ? foreign
        ? ' When you finish, the panel itself starts a review of your diff — a run without ' +
          'a picked tier, i.e. on the model the CLI itself is configured with; its findings come ' +
          'back as a ' +
          'separate task.'
        : ' When you finish, the panel itself starts a review of your diff on the ceiling model; ' +
          'its findings come back here as a separate task.'
      : // Проверки не будет — значит проверять себя некому, кроме самого агента,
        // и сказать это надо прямо, а не умолчать про отсутствующее звено.
        ' The panel will not start a review of this work: nobody checks it but you.')
  );
}

/**
 * Стадия конвейера «разбор → план → работа → ревью → фикс». Одна группа
 * разделения проходит их последовательно, в ОДНОЙ копии репозитория и одной
 * ветке: параллельных агентов от конвейера не прибавляется, прибавляется
 * прогонов.
 *
 * `triage` — разбор разделения на потолке в корне репозитория, один на все
 * группы (Т1): разводит пересечения до старта. `plan` — план группы на потолке
 * в её копии, без права править. `work` — то, что завело разделение; `review`
 * — чтение диффа на потолке без права править; `fix` — правки по замечаниям
 * обратно на модели работы. Ревью второго круга не бывает, иначе пара
 * «проверил — поправил» крутилась бы, пока не упрётся в потолок цепочки.
 *
 * `deliver` — доставка группы с включённой доставкой до MR: коммит, свежая
 * основная ветка, пуш своей ветки, MR. Идёт после правок и после ревью без
 * замечаний — без неё группа кончалась правками в грязной копии, а хаб писал
 * «готово» (живой прогон 24.09.2026, журнал 55/57/58/65). Она и конечна.
 *
 * `push` — единственная стадия, которую заводит НЕ панель, а явный клик
 * человека (Т7): коммит правок по ревью и отправка их в чужой MR. Автоматом она
 * не наступает никогда, поэтому и в цепочке конвейера её нет — она за ней.
 */
export const CASCADE_STAGES = [
  'triage',
  'plan',
  'work',
  'review',
  'fix',
  'deliver',
  'push',
] as const;

export type CascadeStage = (typeof CASCADE_STAGES)[number];

/** Язык блока вердикта: по нему панель узнаёт ответ ревьюера. */
export const REVIEW_BLOCK_LANG = blockLang('review');

/**
 * Сколько замечаний и какой длины панель принимает. Ограничение не про формат, а
 * про то, что этот список уезжает ЗАДАНИЕМ в следующий прогон: простыня на сто
 * пунктов там не задание, а новый разговор, который никто не заказывал.
 */
const MAX_FINDINGS = 20;
const MAX_FINDING_CHARS = 600;

/**
 * Разбор вердикта ревью: `{"findings":[…]}` → список замечаний.
 *
 * Пустой список — законный ответ и главный ожидаемый: «проверил, замечаний нет».
 * `undefined` значит, что блока панель не поняла, — и это НЕ то же самое: по
 * пустому списку цепочка закрывается спокойно, по непонятому — тоже
 * закрывается, но человек видит в ленте сам блок и знает, что его отвергли.
 */
export function parseReviewFindings(raw: unknown): string[] | undefined {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;

  const list = (value as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return undefined;

  const findings: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    findings.push(text.slice(0, MAX_FINDING_CHARS));
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}

/** Что осталось от ответа ревьюера после вырезания блоков и что из них разобрано. */
export interface ReviewScan {
  /** Текст, который видит человек: разбор замечаний словами, без служебного блока. */
  text: string;
  /**
   * Вердикт последнего разобранного блока. `undefined` — блока не было вовсе:
   * ревьюер не отчитался, и заводить по такому ответу правки нельзя.
   */
  findings?: string[];
  /** Сколько закрытых блоков разобрать не удалось — иначе отказ не виден. */
  rejected: number;
}

/** Начало блока: тройная кавычка в начале строки и наш язык за ней. */
const REVIEW_OPEN = new RegExp(
  `(^|\\n)[ \\t]*\`\`\`[ \\t]*${blockLangPattern('review')}[ \\t]*\\r?\\n`,
);

/**
 * Вырезать блоки вердикта из ответа. Правила ровно те же, что у разделения задач
 * и передачи этапа, и написаны здесь заново по той же причине: сабпаты
 * контрактов друг друга не импортируют, а общий модуль пришлось бы тащить через
 * три сборщика сразу.
 *
 * - блок закрыт и разобран → уходит из показа, вердикт достаётся панели;
 * - блок закрыт, а JSON сломан → остаётся в тексте КАК ЕСТЬ: прятать непонятое
 *   значит потерять слова агента без следа;
 * - блок ещё пишется → прячем от него и до конца текста, чтобы лента не
 *   показывала голый JSON, пока ответ печатается.
 */
export function scanReviewBlocks(source: string): ReviewScan {
  let findings: string[] | undefined;
  let rejected = 0;
  let rest = source;
  let out = '';

  for (;;) {
    const open = REVIEW_OPEN.exec(rest);
    if (!open) {
      out += rest;
      break;
    }

    const lead = (open[1] ?? '').length;
    const bodyStart = open.index + open[0].length;
    out += rest.slice(0, open.index + lead);

    const close = /(^|\n)[ \t]*```[ \t]*(\r?\n|$)/.exec(rest.slice(bodyStart));
    if (!close) break;

    const body = rest.slice(bodyStart, bodyStart + close.index);
    const parsed = parseReviewFindings(body);
    if (parsed) {
      findings = parsed;
    } else {
      rejected += 1;
      out += rest.slice(open.index + lead, bodyStart + close.index + close[0].length);
    }

    rest = rest.slice(bodyStart + close.index + close[0].length);
  }

  return {
    text: out.replace(/\n{3,}/g, '\n\n').trim(),
    ...(findings ? { findings } : {}),
    rejected,
  };
}

/** Сколько знаков задания показываем ревьюеру: дальше он читает код, а не текст. */
const TASK_EXCERPT = 2_000;
/** Знаков плана и итога прошлого звена в контексте звена — выжимка, а не пересказ. */
const CONTEXT_EXCERPT = 2_000;

/**
 * Что звено знает о группе, не видя прошлых звеньев (аудит 25.09, L238): чат
 * группы перенаправляется на звено, и продолжение и хаб говорят уже с сессией
 * ревью, правок или доставки — без этого блока у неё не было ни задания, ни
 * плана, ни того, чем кончилось прошлое звено, и она восстанавливала их по диффу.
 */
export interface StageContext {
  /** Задание группы. */
  task?: string;
  /** План группы от звена плана (выжимка). */
  plan?: string;
  /** Ветка копии группы. */
  branch?: string;
  /** Итог прошлого звена: какое звено и чем кончило ответ. */
  previous?: { stage: CascadeStage; text: string };
}

/**
 * Промпты звеньев английские (модели инструкции даются по-английски), а человек
 * читает ответ по-русски: язык ответа — язык задания, а не язык промпта.
 */
export const ANSWER_LANGUAGE_LINE =
  'Write your answer in the language of the task text (the human reads it), not in the ' +
  'language of these instructions.';

/** Язык блока критического замечания — его разбор живёт в `chat-group-settings.ts`. */
export const ESCALATE_BLOCK = blockLang('escalate');

/**
 * Критическое уходит в ГЛАВНЫЙ чат дерева, остальное остаётся в звене. Порог
 * назван прямо, иначе блок стал бы вторым каналом для всего подряд.
 */
export const ESCALATE_LINE =
  'Only if something is CRITICAL — data loss, a security hole, or a decision that blocks the ' +
  'whole task and only the owner can take — also add a code block in the language ' +
  `${ESCALATE_BLOCK} with JSON {"severity":"critical","text":"one paragraph"}: it goes to the ` +
  'main chat. Everything else stays in this answer.';

const STAGE_NAMES: Record<CascadeStage, string> = {
  triage: 'triage',
  plan: 'plan',
  work: 'work',
  review: 'review',
  fix: 'fixes',
  deliver: 'delivery',
  push: 'push',
};

function excerpt(text: string, limit: number, fromEnd = false): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return fromEnd ? `…${trimmed.slice(-limit)}` : `${trimmed.slice(0, limit)}…`;
}

/** Блок «контекст группы» последним абзацем задания звена; пусто — нечего сказать. */
export function stageContextBlock(context: StageContext | undefined): string {
  if (!context) return '';
  const lines: string[] = [];
  if (context.branch) lines.push(`Group branch: ${context.branch}.`);
  if (context.task?.trim()) {
    lines.push('Group task:', excerpt(context.task, TASK_EXCERPT));
  }
  if (context.plan?.trim()) {
    lines.push('Group plan (summary):', excerpt(context.plan, CONTEXT_EXCERPT));
  }
  if (context.previous?.text.trim()) {
    // Хвост, а не начало: итог и вывод звено пишет в конце ответа.
    lines.push(
      `Outcome of the previous stage (${STAGE_NAMES[context.previous.stage]}):`,
      excerpt(context.previous.text, CONTEXT_EXCERPT, true),
    );
  }
  if (lines.length === 0) return '';
  return ['Group context from the panel (you have not seen the previous stages):', ...lines].join(
    '\n',
  );
}

/**
 * Задание звену РЕВЬЮ — первое сообщение нового разговора на потолке.
 *
 * Три вещи, без которых ревью не ревью, а второе мнение. Первое: сессия чистая,
 * работы этой модель не видела — значит смотреть надо дифф, а не помнить. Второе:
 * НИЧЕГО НЕ ПРАВИТЬ. Проверяющий, который сам же и чинит, перестаёт быть
 * проверяющим — его правки уже никто не читает, а платили именно за вторую пару
 * глаз. Третье: ответ обязан быть машинно-читаемым, иначе панель не узнает,
 * заводить ли звено правок, и цепочка молча оборвётся на самом ценном месте.
 *
 * Многострочность здесь безопасна: это ПРОМПТ прогона (уезжает файлом или
 * потоком), а не системная дописка в argv, где перевод строки рвёт командную
 * строку на Windows.
 */
export function reviewStagePrompt(input: {
  /** Задание, с которого шла работа: по нему и сверяется сделанное. */
  task: string;
  /** Чем работу вели — ревьюеру полезно знать, где искать типичные пропуски. */
  model?: string;
  /** Класс работы, если он был распознан. */
  kind?: TaskKind;
  /** Ветка копии, в которой работа велась. */
  branch?: string;
  /** План группы и итог работы — задание уже выше, повторять его незачем. */
  context?: Omit<StageContext, 'task' | 'branch'>;
  /** Абзац сит перед MR (`sievePromptBlock` из `@agentdeck/contracts/sieves`). */
  sieves?: string;
}): string {
  const task = input.task.trim().slice(0, TASK_EXCERPT);
  const by = input.model ? ` by the model ${input.model}` : ' by a model weaker than you';
  const where = input.branch ? ` on the branch ${input.branch}` : ' in this working copy';

  return [
    `This is a new session: the work was done${by}${where}; you do not have its context — read ` +
      'the code and the diff.',
    '',
    'Check what was done against the task. Look at the uncommitted changes and the commits of ' +
      'this branch (git status, git diff, git log), read the touched files in full, and run the ' +
      'project checks (types, lint, tests) if needed.',
    'EDIT NOTHING: your job is to read and name. The next stage makes the fixes.',
    '',
    input.kind ? `Class of work according to the panel: ${input.kind}.` : '',
    'The task the work started from:',
    task,
    '',
    'A finding is only something that must be FIXED: an unmet point of the task, a bug, ' +
      'a broken check, a dangerous or irreversible action. Taste, "could be prettier" and ' +
      'rewriting working code are not findings.',
    `End the answer with EXACTLY ONE code block in the language ${REVIEW_BLOCK_LANG} containing ` +
      'JSON like {"findings":["what to fix and where, one line", "…"]}. No findings — output ' +
      '{"findings":[]}: an empty list is a legitimate and the best answer. Write every finding so ' +
      'it can be carried out without seeing this conversation: file path, what is wrong, what it ' +
      'should be.',
    input.sieves ? `\n${input.sieves}` : '',
    ANSWER_LANGUAGE_LINE,
    ESCALATE_LINE,
    '',
    stageContextBlock(input.context),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Задание звену ПРАВОК — по списку, который выдал ревьюер.
 *
 * Правки идут обратно на модели работы, и это не экономия из принципа: список
 * замечаний уже превратил неизвестное в понятное, а понятную правку по готовому
 * перечню слабая модель делает ровно так же, как сильная. Ревью второго круга
 * панель не заводит — здесь цепочка заканчивается.
 */
export function fixStagePrompt(
  findings: string[],
  options: {
    /** Ветка копии, в которой шла работа. */
    branch?: string;
    /**
     * Кто был ревьюером. `ceiling` — потолок разговора, и он по построению
     * сильнее работы. `cli` — настроенная модель чужого CLI: она сильнее
     * подобранной ступени только по замыслу, а чем именно настроен CLI, панель
     * не знает, — поэтому в задании говорится «другая модель», а не «сильнее».
     */
    reviewer?: 'ceiling' | 'cli';
    /**
     * Группа доводит работу до MR, и за правками панель заведёт звено
     * доставки. Без этой строки «ничего сверх списка» агент читал как запрет
     * коммита и MR и кончал грязной копией (журнал 59d, 65).
     */
    deliver?: boolean;
    /** Задание, план и итог ревью — звено правок прошлых звеньев не видело. */
    context?: StageContext;
  } = {},
): string {
  const { branch, reviewer = 'ceiling', deliver = false } = options;
  const context = stageContextBlock(options.context);
  const where = branch ? ` on the branch ${branch}` : ' in this working copy';
  const who = reviewer === 'cli' ? 'another model' : 'a stronger model';

  return [
    `This is a new session: ${who} reviewed the work${where} — here are its findings.`,
    '',
    ...findings.map((finding, index) => `${index + 1}. ${finding}`),
    '',
    'Fix each one. Any order, but go through the whole list and say for every point what you ' +
      'did; if you disagree with one, do not stay silent — explain why you left it as it was.',
    'Do not rework code beyond the list: these are review fixes, not a second pass at the task.',
    ...(deliver
      ? [
          'That limit is about code, not delivery: commit, push and MR are not forbidden by it. ' +
            'The delivery stage the panel starts after your turn takes the branch to an MR — do ' +
            'not ask permission for them and do not stop for them.',
        ]
      : []),
    // Не воспроизвелось — не повод тянуть инфраструктуру (аудит 25.09, L258).
    'A finding that does not reproduce for you is no reason to change infrastructure: no new ' +
      'dependencies, CI, tsconfig or test harness edits. Say what did not reproduce and how much ' +
      'would have to be added, and ask the human with the AskUserQuestion tool.',
    'Before you say "done", run the project checks (types, lint, tests — whatever it has).',
    ANSWER_LANGUAGE_LINE,
    ESCALATE_LINE,
    ...(context ? ['', context] : []),
  ].join('\n');
}

/**
 * Задание звену ДОСТАВКИ (журнал 59a, 61b): группа с включённой доставкой
 * прошла работу, ревью и правки — осталось довести ветку до MR.
 *
 * Отдельное звено, а не строка в правках: правки идут по списку и кончаются
 * «готово», а доставка — другая работа с другим мерилом (чистая копия, ветка
 * на удалённом, MR с её головой — то, что потом сверяет `delivery-facts`).
 *
 * Свежая основная ветка — здесь же (61b): основная уходит вперёд, пока группы
 * работают, и конфликт, найденный при слиянии MR, стоит человеку больше, чем
 * найденный агентом до пуша.
 *
 * Уже отправленная ветка, отставшая от основной (решение владельца, W3-3), —
 * тот же rebase и `--force-with-lease` СВОЕЙ ветки: ветка группы принадлежит
 * группе, и переписать её — не то же, что переписать общую историю. Основная,
 * защищённая и чужая ветка под это не попадают никогда, а конфликт такого
 * rebase — вопрос человеку: разрешать его значит решать за чужую работу в
 * основной. Разрешение сторожа git на это даёт слой ~/.claude, не панель.
 */
export function deliverStagePrompt(input: {
  /** Ветка копии группы — её и отправлять. */
  branch?: string;
  /**
   * После чего звено заведено: правки по ревью, ревью без замечаний или работа,
   * которой ревью не положено (шла на потолке, потолок не записан, — M8).
   */
  after: 'fix' | 'review' | 'work';
  /**
   * Звено ведёт чужой CLI: инструмента вопросов у него нет, и вопрос человеку —
   * это ход, кончившийся вопросом (панель читает его как паузу, Д3).
   */
  foreign?: boolean;
  /** Задание, план и итог прошлого звена — доставка прошлых звеньев не видела. */
  context?: StageContext;
  /**
   * Абзац сит перед MR (`sievePromptBlock`). Строкой, а не импортом: сабпаты
   * контрактов друг друга не импортируют.
   */
  sieves?: string;
}): string {
  const branch = input.branch ? `the branch ${input.branch}` : 'the branch of this copy';
  const context = stageContextBlock(input.context);
  const target = input.branch ?? 'HEAD';
  const ask = input.foreign
    ? 'a question to the human as the last line of the answer'
    : 'a question to the human with the AskUserQuestion tool';
  const before =
    input.after === 'fix'
      ? 'the work of this group was reviewed and the fixes for its findings are done'
      : input.after === 'review'
        ? 'the work of this group was reviewed and the review found nothing'
        : 'the work of this group is finished; it has no separate review';

  return [
    `This is a new session: ${before}. Your stage is delivering ${branch} to a ready MR; ` +
      (context
        ? 'what the panel knows about the previous stages is at the end of the task; read the ' +
          'rest in the copy, git and the checkpoint files in .agent/.'
        : 'you have no context of the previous stages — read the copy, git and the checkpoint ' +
          'files in .agent/.'),
    '',
    '1. `git status`: commit the work of the group following the project convention for ' +
      'messages; do not put temporary files, screenshots or .agent/ notes into the commit.',
    '2. Fresh main branch: `git fetch origin`, the name of the main branch is `git symbolic-ref ' +
      'refs/remotes/origin/HEAD`, then `git rebase origin/<main>` — both when the branch is not ' +
      'pushed yet and when it is pushed but behind the main branch.',
    '3. A rebase conflict of a not-yet-pushed branch within the tasks of the group — resolve it ' +
      `yourself. The branch was already pushed — a conflict of that rebase: ${ask} with a ` +
      'recommended option (`git rebase --abort` returns the branch as it was). A decision that ' +
      `belongs to the human or to another group (foreign code, a product choice) — also ${ask}, ` +
      'not a report.',
    '4. Run the project checks; fix what is red without going beyond the tasks of the group.',
    `5. Push the branch: the first time with a plain push (\`git push -u origin ${target}\`); ` +
      `a pushed branch after the rebase — \`git push --force-with-lease origin ${target}\`, and ` +
      "only your own group branch, never the main, a protected or another group's branch. Open " +
      'the MR by the project delivery skill (or update the open one): task keys in the ' +
      'description, decisions taken without the human listed there too. Stages of the skill not ' +
      'passed yet (live check after the edits, before/after shots, tracker) are yours as well.',
    // Итог по MR без его обсуждений (аудит 25.09, L199): ревьюер оставил тред,
    // группа сказала «готово», а тред так и висел открытым.
    '6. Before "done" re-read ALL discussions of the MR (threads and reviewer comments): ' +
      'fix what is unresolved in this branch; list what you did not fix in the answer as ' +
      '"not fixed" with the reason — a thread left silently is not an outcome.',
    // Автономия группы держится на границе задания (аудит 25.09, L163): без
    // сверки в MR уезжали правки «заодно», которых задание не просило.
    '7. Compare the diff of the branch against main (`git diff --stat origin/<main>...HEAD`) ' +
      'with the task of the group: every change must follow from its tasks. Revert the extra; a ' +
      'step beyond the tasks of the group (a foreign module, a migration, infrastructure) — do ' +
      `not do it, ${ask}.`,
    ...(input.sieves ? ['', input.sieves] : []),
    '',
    'Do not change code beyond what delivery needs. Merging the MR and deleting branches are ' +
      'forbidden; force-push without a lease (`--force`) is always forbidden. The last line of ' +
      'the answer is the link to the MR.',
    ANSWER_LANGUAGE_LINE,
    ESCALATE_LINE,
    ...(context ? ['', context] : []),
  ].join('\n');
}

/**
 * Задание группе РЕВЬЮ ПО ССЫЛКЕ (Т7): проверить чужой запрос на слияние.
 *
 * От `reviewStagePrompt` отличается предметом, и это не оттенок: там панель
 * проверяет работу, которую сама же и завела (задание известно, ветка своя),
 * здесь — чужой MR, про который панель знает одну ссылку. Поэтому задание
 * называет скилл `deep-review` прямо: он умеет читать MR по ссылке, и без него
 * агент каждый раз изобретает свой обход диффа.
 *
 * Формат ответа тот же самый, и намеренно: замечания собирает тот же
 * `scanReviewBlocks`, а карточку решения панель строит по тому же списку.
 * Второго формата у ревью быть не должно.
 */
/**
 * Где стоит копия MR — одной строкой для заданий ревью, работы и push.
 * Ветка MR занята другой копией — копия в detached HEAD на удалённой ветке
 * (Д2): коммитить можно, а отправлять только явным `HEAD:<ветка>`, иначе push
 * завёл бы новую удалённую ветку или не ушёл вовсе.
 */
function mergeRequestPushTarget(input: { branch: string; remote?: string; detached?: boolean }) {
  const remote = input.remote ?? 'origin';
  return input.detached
    ? `git push ${remote} HEAD:${input.branch}`
    : `git push ${remote} ${input.branch}`;
}

export function reviewLinkPrompt(input: {
  /** Ссылка на MR/PR — её агент и открывает. */
  url: string;
  /** Ветка копии, в которой он работает. */
  branch?: string;
  /**
   * Копия стоит на ветке MR. `false` — ветку получить не удалось (нет
   * интеграции, MR не прочитан), и копия отведена от базы: молчать об этом
   * нельзя, иначе агент будет искать в диффе то, чего в нём нет.
   */
  onMrBranch?: boolean;
  /** Копия в detached HEAD на удалённой ветке MR: сама ветка занята другой копией. */
  detached?: boolean;
  remote?: string;
  /** Что именно просили проверить — задачи группы из предложения. */
  tasks?: string[];
  /** Общий контекст разделения. */
  shared?: string;
}): string {
  const { url, branch, onMrBranch = true, tasks = [], shared, detached, remote } = input;

  return [
    // Пустые строки здесь не разделители, а мусор: `filter(Boolean)` их
    // выбрасывает — как и в соседних заданиях звеньев.
    shared ?? '',
    `This is a new session: review the merge request ${url}.`,
    branch && onMrBranch && detached
      ? `The working copy is in detached HEAD at ${remote ?? 'origin'}/${branch} — the head of ` +
        'this MR (the branch itself is checked out by another copy); read the diff right here.'
      : branch && onMrBranch
        ? `The working copy is already on its branch ${branch} — read the diff right here.`
        : '⚠ A copy on the branch of this MR could not be made: it is branched from the base. ' +
          'Take the diff from the MR itself by the link, not from this copy.',
    'Use the deep-review skill on this link: it is the way to read the MR in full. ' +
      'No such skill — read the MR diff and the touched files yourself, in the same order.',
    'EDIT NOTHING and write nothing into the MR: whether to fix or reply is decided by the human ' +
      'on the panel card.',
    // Задачи группы пишет агент родителя, и в них попадает «закоммить и
    // запушь» (инцидент 23.09). Без этой оговорки задание спорило само с собой.
    tasks.length > 0
      ? 'What you were asked to look at especially (these are points to CHECK: read "fix", ' +
        '"commit", "push" in them as "check whether this is needed", and do nothing):'
      : '',
    ...tasks.map((task, index) => `${index + 1}. ${task}`),
    'A finding is only something that must be FIXED: a bug, an unmet requirement, a broken ' +
      'check, a dangerous or irreversible action. Taste and "could be prettier" are not findings.',
    `End the answer with EXACTLY ONE code block in the language ${REVIEW_BLOCK_LANG} containing ` +
      'JSON like {"findings":["file:line — what is wrong and what it should be", "…"]}. No ' +
      'findings — output {"findings":[]}: an empty list is a legitimate and the best answer. Write ' +
      'every finding so that someone who has not seen this conversation understands it: the panel ' +
      'posts them into the MR as they are.',
    ANSWER_LANGUAGE_LINE,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Первый абзац задания группы, которая РАБОТАЕТ в MR (конфликты, замечания,
 * rebase), а не ревьюит его. Само задание — обычное задание группы ниже; здесь
 * только то, чего оно не знает: чей это MR, стоит ли копия на его ветке и что
 * запись в чужой MR (push, комментарий, описание) — решение человека.
 */
export function mergeRequestWorkPreamble(input: {
  url: string;
  branch?: string;
  onMrBranch?: boolean;
  detached?: boolean;
  remote?: string;
}): string {
  const { url, branch, onMrBranch = true, detached, remote } = input;
  return [
    `This session works in the merge request ${url}.`,
    branch && onMrBranch && detached
      ? `The working copy is in detached HEAD at ${remote ?? 'origin'}/${branch} — the head of ` +
        `this MR (the branch ${branch} itself is checked out by another copy). Edit and commit ` +
        `here; push only with \`${mergeRequestPushTarget({ branch, ...(remote ? { remote } : {}), detached })}\`, ` +
        'do not create new branches.'
      : branch && onMrBranch
        ? `The working copy is already on its branch ${branch}: edit here and commit into it.`
        : '⚠ A copy on the branch of this MR could not be made: it is branched from the base. ' +
          'First switch to the MR branch (find it by the link) and only then edit.',
    'Push, comments and editing the MR description — only after the explicit consent of the ' +
      'human: ask with a question with options when you reach that step.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Сообщение чату правок после явного «Закоммитить и отправить в MR» (Т7).
 *
 * Отдельным кликом, а не хвостом задания правок: запись в чужую ветку — это то,
 * чего панель не делает сама ни при каких настройках. Согласие человека
 * называется в тексте прямо, потому что у агента свои предохранители на push, и
 * ему нужно знать, что оно получено.
 */
export function reviewPushPrompt(input: {
  url: string;
  /**
   * Ветка MR. Обязательна: без неё push ушёл бы «в ветку этой копии», а это
   * может быть `<ветка>-2` от main — новая удалённая ветка, а не MR (Д9).
   * Панель без известной ветки MR кнопку push не предлагает вовсе.
   */
  branch: string;
  remote?: string;
  detached?: boolean;
}): string {
  const command = mergeRequestPushTarget(input);

  return [
    `The human pressed "Commit and push to MR" — this is explicit consent to commit and push ` +
      `to the branch ${input.branch}.`,
    `Commit the review fixes as one meaningful commit and push them with \`${command}\` ` +
      `— that is the branch of ${input.url}. Do not push to another branch and do not create ` +
      'new branches.',
    'Merge nothing and do not close the MR: merging stays with the human.',
    'Before committing, run the project checks (types, lint, tests — whatever it has) and say ' +
      'what went into the MR.',
    ANSWER_LANGUAGE_LINE,
  ].join('\n');
}

/**
 * Сообщение в ТУ ЖЕ сессию ревью, которое кончилось без блока итога (Д4).
 *
 * Ревью заново не заказывается: разговор уже прочитал MR, и потерян только
 * итог в том виде, который панель умеет прочитать.
 */
export function reviewRetryPrompt(): string {
  return [
    `Your previous answer ended without the outcome block ${REVIEW_BLOCK_LANG} — the panel ` +
      'does not know whether there are findings, and the human sees "no outcome".',
    'Do not start the review again: from what you have already read, output the outcome as ' +
      `EXACTLY ONE code block in the language ${REVIEW_BLOCK_LANG} containing JSON like ` +
      '{"findings":["file:line — what is wrong and what it should be", "…"]}. No findings — ' +
      '{"findings":[]}. Not finished reading — finish, but end the answer with this block.',
    'EDIT NOTHING and write nothing into the MR.',
    ANSWER_LANGUAGE_LINE,
  ].join('\n');
}

/** Группа глазами подбора: класс от агента и факты, которые панель видит сама. */
export interface CascadeGroup {
  /** Род работы из блока разделения — любая строка, проверяем здесь. */
  kind?: string;
  /**
   * Просьба агента о модели и глубине. Действует ТОЛЬКО ВВЕРХ: считаешь группу
   * сложнее её класса — поднимай; понизить ниже класса нельзя. Иначе модель
   * экономила бы на себе, а «сомневаешься → потолок» осталось бы обещанием.
   */
  model?: string;
  effort?: string;
  /** Сколько задач в группе. */
  tasks?: number;
  /** Длина задания в знаках. */
  length?: number;
}

/** Итог подбора: с чем стартует ребёнок и надо ли проверять его работу. */
export interface CascadePlan extends CascadeChoice {
  /** Класс, если он распознан: показывается на карточке и в связи чата. */
  kind?: TaskKind;
  /**
   * Работа идёт НИЖЕ потолка — значит ей поднимается планка сдачи
   * (`loweredWorkPrompt`), а на этапе 2 отсюда же возьмётся право завести звено
   * ревью. Ребёнок, ехавший на потолке, ни того, ни другого не получает:
   * усиливать нечем.
   *
   * Ниже — это и меньшая модель, и меньшая глубина: прогон на той же модели, но
   * с быстрым продумыванием, проверка на потолке всё ещё усиливает.
   */
  lowered: boolean;
}

/**
 * Сколько прогонов заведёт разделение В ХУДШЕМ случае: у группы на потолке он
 * один, у понижённой — до трёх (работа, ревью, правки по его замечаниям).
 *
 * Считается ДО запуска и показывается на карточке, потому что это и есть цена
 * согласия: человек, нажимающий «Разделить», обязан видеть, сколько агентов
 * панель заведёт сама. «До» здесь не осторожность — ревью без замечаний
 * заканчивает цепочку на двух прогонах, и так бывает чаще всего.
 */
export function plannedRunCount(
  plans: Array<Pick<CascadePlan, 'lowered'>>,
  options: {
    /**
     * Уровни плана включены (Т1): плюс один прогон разбора на всё разделение и
     * по прогону плана на каждую группу — они идут при подборе всегда, у групп
     * на потолке тоже.
     */
    planned?: boolean;
  } = {},
): number {
  const runs = plans.reduce(
    (total, plan) => total + (plan.lowered ? 3 : 1) + (options.planned ? 1 : 0),
    0,
  );
  return options.planned && plans.length > 0 ? runs + 1 : runs;
}

/**
 * Подбор модели под группу. Порядок шагов не переставлять — он и есть алгоритм:
 *
 * 1. потолок не распознан → подбора нет, всё едет на потолке (fail-closed);
 * 2. потолок ниже opus → не понижаем вовсе: экономить нечего, риск остаётся;
 * 3. класс не назван или незнаком → потолок («сомневаешься — не указывай класс»);
 * 4. класс, который нельзя удешевлять (`design`/`investigation`/`review`) → потолок;
 * 5. план класса; большая группа механикой не бывает — ранг +1 по фактам;
 * 6. просьба агента — только вверх;
 * 7. клэмп потолком, и `max` не возвращается никому.
 */
export function planAssignment(group: CascadeGroup, ceiling: CascadeCeiling): CascadePlan {
  const atCeiling = (kind?: TaskKind): CascadePlan => ({
    model: ceiling.model,
    effort: ceilingEffortValue(ceiling.effort),
    lowered: false,
    ...(kind ? { kind } : {}),
  });

  const ceilingRank = ceilingModelRank(ceiling.model);
  if (ceilingRank === undefined || ceilingRank <= MODEL_RANK.sonnet) return atCeiling();

  const kind = TASK_KINDS.find((known) => known === normalize(group.kind));
  if (!kind) return atCeiling();

  const plan = KIND_PLAN[kind];
  if (!plan) return atCeiling(kind);

  const planned: KindPlan = isBigGroup(group)
    ? {
        // Ранг с единицы, индекс с нуля — поэтому [ранг] и есть «ступенью выше».
        model: ASSIGNABLE_MODELS[MODEL_RANK[plan.model]] ?? plan.model,
        effort: EFFORT_RANK[plan.effort] < EFFORT_RANK.high ? 'high' : plan.effort,
      }
    : plan;

  // Просьба агента считается только если она СИЛЬНЕЕ плана класса.
  const askedModel = assignableModel(group.model);
  const askedEffort = assignableEffort(group.effort);
  const model =
    askedModel && MODEL_RANK[askedModel] > MODEL_RANK[planned.model] ? askedModel : planned.model;
  const effort =
    askedEffort && EFFORT_RANK[askedEffort] > EFFORT_RANK[planned.effort]
      ? askedEffort
      : planned.effort;

  return decide({ model, effort }, ceiling, kind);
}

/**
 * Выбор ЧЕЛОВЕКА на карточке — в отличие от просьбы агента он действует и вниз.
 *
 * Разница не в доверии, а в том, кто отвечает за результат: понижать себе модель
 * агент не должен (иначе «мне хватит haiku» станет решением о самом себе), а
 * человек, поставивший группе haiku руками, видел её задачи и решил так. Потолок
 * держится и здесь: выше выбранного им же максимума не поднимается ничто.
 */
export function manualAssignment(
  wish: CascadeAssignment,
  ceiling: CascadeCeiling,
  kind?: TaskKind,
): CascadePlan {
  return decide(wish, ceiling, kind);
}

/**
 * Сколько групп вообще может быть в предложении. Дубль потолка из `task-split`
 * намеренный: сабпаты контрактов друг друга не импортируют (условие работы
 * сервера без сборки), а здесь это не формат разделения, а граница разумного для
 * ключей карты — расходиться этим числам нечем.
 */
const MAX_ASSIGNMENT_KEYS = 8;

/**
 * Ручные замены с карточки: номер группы → чего человек для неё хочет.
 *
 * Едут ОТДЕЛЬНЫМ полем запроса, а не внутри предложения агента, и это не
 * оформление. Просьба агента действует только вверх (`planAssignment`), выбор
 * человека — в обе стороны (`manualAssignment`); подмешай мы одно в другое, на
 * сервере их было бы не различить, и поставленный руками `haiku` молча уехал бы
 * на потолке.
 */
export function parseAssignments(raw: unknown): Map<number, CascadeAssignment> {
  const out = new Map<number, CascadeAssignment>();
  if (!raw || typeof raw !== 'object') return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_ASSIGNMENT_KEYS) continue;
    if (!value || typeof value !== 'object') continue;

    const wish = value as { model?: unknown; effort?: unknown };
    const model = assignableModel(typeof wish.model === 'string' ? wish.model : undefined);
    const effort = assignableEffort(typeof wish.effort === 'string' ? wish.effort : undefined);
    // Пустая замена — это не замена: без неё группа идёт обычным подбором, и
    // записать её значило бы отменить подбор молча.
    if (!model && !effort) continue;
    out.set(index, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  }

  return out;
}

/** Общий хвост обоих путей: клэмп потолком и пометка «работа слабее потолка». */
function decide(
  wish: CascadeAssignment,
  ceiling: CascadeCeiling,
  kind: TaskKind | undefined,
): CascadePlan {
  const choice = clampAssignment(wish, ceiling);
  const ceilingRank = ceilingModelRank(ceiling.model);
  const modelRank = MODEL_RANK[assignableModel(choice.model) ?? 'fable'];
  const effortRank = EFFORT_RANK[assignableEffort(choice.effort) ?? 'xhigh'];

  return {
    ...choice,
    ...(kind ? { kind } : {}),
    lowered:
      ceilingRank !== undefined &&
      (modelRank < ceilingRank || effortRank < ceilingEffortRank(ceiling.effort)),
  };
}

/**
 * Запись журнала понижённых прогонов: чем прогон вели и видела ли панель, что он
 * выполнил планку сдачи.
 *
 * Журнал существует потому, что до него отметка `lowered` умирала в маршруте:
 * сервер разворачивал по ней алиас, дописывал планку сдачи — и забывал. Ответить
 * на вопрос «а понижение вообще окупается» было нечем, и по той же причине
 * оставался неисполнимым подбор класса по аналитике: данных, на которых он
 * строится, никто не копил.
 *
 * `checks` — команды прогона, похожие на проверки проекта. ПУСТО ЗНАЧИТ «панель
 * их не видела», а не «агент их не прогонял»: видно только вызовы `Bash`, и
 * проверка, запущенная своим инструментом или MCP-сервером, сюда не попадёт.
 * Формулировка в интерфейсе обязана быть такой же осторожной.
 */
export interface LoweredRunRecord {
  /** Ключ разговора, под которым прогон стартовал. */
  chatId: string;
  /** Настоящий ключ сессии — появляется через пару секунд после старта. */
  sessionId?: string;
  /** Каталог проекта; у песочницы и домашнего чата его нет. */
  projectPath?: string;
  /** Ступень, на которой прогон уехал: уже развёрнутая, не алиас. */
  model: string;
  effort: string;
  /**
   * Класс работы, которым подбор объяснил ступень. Пусто у ручного веера: там
   * ступень выбрал человек, и рода работы никто не называл.
   */
  kind?: string;
  startedAt: number;
  finishedAt: number;
  /** Прогон закончился без ошибки. */
  ok: boolean;
  /** Замеченные команды проверок, по одной строке; пусто — не замечено ни одной. */
  checks: string[];
  /**
   * Сколько окна прогон съел — сумма всех токенов шага (вход, выход и оба кеша).
   * Необязательное: записи, сделанные до 08.09.2026, этого числа не знают, и
   * читаются они по-прежнему.
   */
  tokens?: number;
}

function clampModel(wanted: string | undefined, ceiling: string): string {
  const model = assignableModel(wanted);
  if (!model) return ceiling;

  const ceilingRank = ceilingModelRank(ceiling);
  if (ceilingRank === undefined) return ceiling;

  return MODEL_RANK[model] < ceilingRank ? model : ceiling;
}

function clampEffort(wanted: string | undefined, ceiling: string): string {
  const effort = assignableEffort(wanted);
  const base = ceilingEffortValue(ceiling);
  if (!effort) return base;

  return EFFORT_RANK[effort] <= ceilingEffortRank(ceiling) ? effort : base;
}
