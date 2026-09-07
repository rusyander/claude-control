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

  const top = ceiling.model || 'модель по умолчанию';
  return (
    'Модель для каждой группы подбирает панель, а не ты: у группы укажи поле kind — ' +
    'mechanical (переименования, одна и та же правка во многих файлах, формат, переносы), ' +
    'implementation (понятная правка или фича с готовыми критериями приёмки), ' +
    'tests (тесты по готовой спецификации), ' +
    'investigation (причина неизвестна: плавающий баг, производительность, разбор чужого кода), ' +
    'design (архитектура, контракты, миграции, безопасность, необратимое), ' +
    'review (проверка чужой работы). ' +
    `Потолок этого разговора — ${top}, выше него не поднимается ничто. ` +
    'Считаешь группу сложнее её класса — добавь ей model и effort повыше ' +
    `(модели: ${models.join(', ')}; глубина: ${assignableEffortsUpTo(ceiling.effort).join(', ')}); ` +
    'понизить ниже своего класса группа не может. ' +
    'Сомневаешься в классе — не указывай kind вовсе: такая группа пойдёт на потолке. ' +
    'Группе слабее потолка панель сама поднимет планку сдачи и после её работы заведёт ревью ' +
    `на ${top} по тому же диффу — закладывать на это в задании ничего не надо.`
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
     * Заведёт ли панель ревью этой работы. У Claude — да, и об этом говорится
     * прямо. У ЧУЖОГО провайдера конвейер не работает вовсе (он живёт на реестре
     * прогонов Claude), и обещание «панель сама заведёт ревью» было бы враньём в
     * задании: агент рассчитывал бы на вторую пару глаз, которой не будет.
     */
    review?: boolean;
  } = {},
): string {
  const named = kind ? `«${kind}»` : 'простую работу';
  const review = options.review ?? true;
  return (
    'Эту работу ведёт модель НИЖЕ потолка разговора: панель подобрала её по роду задачи. ' +
    'Прежде чем сказать «готово», прогони проверки проекта (типы, линт, тесты — что в нём есть) ' +
    'и сверь сделанное с заданием по пунктам. ' +
    `Если по ходу выяснится, что задача сложнее, чем ${named}, — нужны решения об архитектуре, ` +
    'контрактах, миграциях или причина сбоя неизвестна, — не выкручивайся: опиши, во что упёрся, ' +
    'и заверши ход, работу продолжат на более сильной модели. ' +
    'Незаконченное называй незаконченным: остановка с честным списком того, что осталось, стоит ' +
    'дешевле правдоподобного «готово», за которым правок больше, чем было работы.' +
    (review
      ? ' Когда ты закончишь, панель сама заведёт ревью твоего диффа на модели-потолке; ' +
        'его замечания вернутся сюда же отдельным заданием.'
      : // Проверки не будет — значит проверять себя некому, кроме самого агента,
        // и сказать это надо прямо, а не умолчать про отсутствующее звено.
        ' Ревью этой работы панель не заведёт: проверить сделанное некому, кроме тебя.')
  );
}

/**
 * Стадия конвейера «работа → ревью → фикс». Одна группа разделения проходит их
 * последовательно, в ОДНОЙ копии репозитория и одной ветке: параллельных агентов
 * от конвейера не прибавляется, прибавляется прогонов.
 *
 * `work` — то, что завело разделение; `review` — чтение диффа на потолке без
 * права править; `fix` — правки по замечаниям обратно на модели работы. `fix`
 * конечен: ревью второго круга не бывает, иначе пара «проверил — поправил»
 * крутилась бы, пока не упрётся в потолок цепочки.
 */
export const CASCADE_STAGES = ['work', 'review', 'fix'] as const;

export type CascadeStage = (typeof CASCADE_STAGES)[number];

/** Язык блока вердикта: по нему панель узнаёт ответ ревьюера. */
export const REVIEW_BLOCK_LANG = 'agentdeck:review';

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
const REVIEW_OPEN = new RegExp(`(^|\\n)[ \\t]*\`\`\`[ \\t]*${REVIEW_BLOCK_LANG}[ \\t]*\\r?\\n`);

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
}): string {
  const task = input.task.trim().slice(0, TASK_EXCERPT);
  const by = input.model ? ` моделью ${input.model}` : ' моделью слабее тебя';
  const where = input.branch ? ` в ветке ${input.branch}` : ' в этой рабочей копии';

  return [
    `Это новая сессия: работа велась${by}${where}, её контекста у тебя нет — читай код и дифф.`,
    '',
    'Проверь сделанное против задания. Посмотри незакоммиченные изменения и коммиты этой ветки ' +
      '(git status, git diff, git log), прочитай затронутые файлы целиком, при необходимости ' +
      'прогони проверки проекта (типы, линт, тесты).',
    'НИЧЕГО НЕ ПРАВЬ: твоя работа — прочитать и назвать. Правки сделает следующее звено.',
    '',
    input.kind ? `Класс работы по мнению панели: ${input.kind}.` : '',
    'Задание, с которого шла работа:',
    task,
    '',
    'Замечанием считается только то, что надо ИСПРАВИТЬ: невыполненный пункт задания, ошибка, ' +
      'сломанная проверка, опасное или необратимое действие. Вкусовые предпочтения, «можно было ' +
      'бы красивее» и переписывание работающего кода замечаниями не являются.',
    `Закончи ответ РОВНО ОДНИМ блоком кода с языком ${REVIEW_BLOCK_LANG}, внутри — JSON вида ` +
      '{"findings":["что и где исправить, одной строкой", "…"]}. Замечаний нет — выведи ' +
      '{"findings":[]}: пустой список это законный и лучший ответ. Каждое замечание пиши так, ' +
      'чтобы его можно было исполнить, не видя этого разговора: путь к файлу, что не так, что ' +
      'должно быть.',
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
export function fixStagePrompt(findings: string[], branch?: string): string {
  const where = branch ? ` в ветке ${branch}` : ' в этой рабочей копии';

  return [
    `Это новая сессия: работу${where} проверила модель сильнее — вот её замечания.`,
    '',
    ...findings.map((finding, index) => `${index + 1}. ${finding}`),
    '',
    'Исправь каждое. Порядок свой, но пройди список целиком и по каждому пункту скажи, что ' +
      'сделал; с чем не согласен — не молчи, объясни, почему оставил как было.',
    'Ничего сверх списка не переделывай: это правки по ревью, а не второй заход на задачу.',
    'Перед тем как сказать «готово», прогони проверки проекта (типы, линт, тесты — что в нём есть).',
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
export function plannedRunCount(plans: Array<Pick<CascadePlan, 'lowered'>>): number {
  return plans.reduce((total, plan) => total + (plan.lowered ? 3 : 1), 0);
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
  startedAt: number;
  finishedAt: number;
  /** Прогон закончился без ошибки. */
  ok: boolean;
  /** Замеченные команды проверок, по одной строке; пусто — не замечено ни одной. */
  checks: string[];
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
