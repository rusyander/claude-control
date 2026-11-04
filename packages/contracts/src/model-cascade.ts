import { blockLang, blockLangPattern } from './brand.ts';
import { labelledCut, RULE_SOURCES } from './quality-floor.ts';

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
  // Понятная правка или фича с готовыми критериями приёмки. Пол — opus high
  // (владелец, 12.10.2026: «качество первым, окно вторым»): правка кода по
  // задаче из трекера на sonnet возвращалась ревью с замечаниями чаще, чем
  // экономила окно, а исполнение у владельца везде идёт на high.
  implementation: { model: 'opus', effort: 'high' },
  // Тесты по готовой спецификации — та же работа с кодом, тот же пол.
  tests: { model: 'opus', effort: 'high' },
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
 * провайдеров (`domains/provider-cascade/provider-cascade.ts`): у них другая лестница моделей, но
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
    /**
     * За правками панель заведёт один проход проверки (U6): строка «тебя никто
     * не проверит» была бы враньём, а обещание проверки — новая обязанность.
     */
    verify?: boolean;
    /**
     * Задание этого прогона уже назвало проверки проекта (TQ-10, 12.10.2026):
     * правки несут `PROJECT_CHECKS_LINE`, работа с доставкой —
     * `DELIVERY_CHECKS_LINE`. Определение второй раз — лишние 250 байт в том
     * же прогоне; остаётся ссылка на задание.
     */
    checksInTask?: boolean;
  } = {},
): string {
  const named = kind ? `"${kind}"` : 'simple work';
  const review = options.review ?? true;
  const foreign = options.reviewer === 'cli';
  // Подъём заводит конвейер работы (F4, 12.10.2026): ход понижённой работы без
  // единой правки идёт заново на потолке. Правкам и ручному вееру его нет — и
  // обещать его там нельзя: агент рассчитывал бы на продолжение, которого не будет.
  const stop = review
    ? 'do not improvise: leave the copy unchanged, describe what you hit and end the turn — the ' +
      `panel re-runs the task on ${foreign ? 'the model the CLI itself is configured with' : 'the ceiling model'}` +
      ', and a turn with half-made changes goes to the review as it is. '
    : 'do not improvise: describe what you hit and end the turn — the human reads it and decides ' +
      'how the work continues. ';
  return (
    (foreign
      ? 'This work runs on a model BELOW the one the CLI uses by its own setting: ' +
        'the panel picked it by the kind of task. '
      : 'This work runs on a model BELOW the ceiling of the conversation: the panel picked it by ' +
        'the kind of task. ') +
    `${options.checksInTask ? CHECKS_NAMED_IN_TASK : PROJECT_CHECKS_LINE} Then compare what you did with the task point by point. ` +
    `If it turns out the task is harder than ${named} — decisions about architecture, ` +
    'contracts or migrations are needed, or the cause of a failure is unknown — ' +
    stop +
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
      : options.verify
        ? ' When you finish, the panel starts one verification pass over your fixes: it re-runs ' +
          'the evidence of every finding, and a point that is not really fixed goes into the MR ' +
          'as open.'
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
 * Сколько замечаний и какой длины панель принимает. Замечание — полная карточка
 * (важность, тезис, место, доказательство, как должно быть), а не заголовок:
 * прежние 600 знаков и 20 пунктов обрезали доказательства и выбрасывали
 * хвост списка (владелец, 12.10.2026). Потолки — от мусора; сверх них панель
 * говорит, сколько не взяла, молча ничего не теряется.
 */
export const REVIEW_MAX_FINDINGS = 200;
const MAX_FINDINGS = REVIEW_MAX_FINDINGS;
const MAX_FINDING_CHARS = 12_000;

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
  let over = 0;
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    if (findings.length >= MAX_FINDINGS) {
      over += 1;
      continue;
    }
    findings.push(labelledCut(text, MAX_FINDING_CHARS));
  }
  if (over > 0) {
    findings.push(
      `… ${over} more findings were not taken by the panel (limit ${MAX_FINDINGS}) — they are in the review answer above.`,
    );
  }
  return findings;
}

/** Тир риска ревью: T0 — взгляд, T1 — обычная глубина, T2 — жёсткая. */
export const REVIEW_TIERS = ['T0', 'T1', 'T2'] as const;
export type ReviewTier = (typeof REVIEW_TIERS)[number];

/**
 * Отчёт ревьюера о глубине — рядом с замечаниями в том же блоке (U4).
 *
 * «Замечаний нет» без него читалось как «чисто», хотя ревью могло пройти одним
 * входом, без половины радиуса и без документации (живое ревью MR 12.10.2026:
 * радиус 11 из 169, документация наполовину). Панель не верит тону ответа —
 * она читает отчёт и судит его сама (`reviewDepthGaps`).
 */
export interface ReviewDepth {
  tier?: ReviewTier;
  /** Независимые входы, с которых ревьюер прошёл целиком: diff-first, frame-first… */
  entries: string[];
  coverage?: 'full' | 'partial';
  /** Что не прочитано и почему. */
  uncovered: string[];
}

function textList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** `depth` из JSON блока ревью; нет поля или оно не объект — `undefined`. */
export function parseReviewDepth(raw: unknown): ReviewDepth | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const tier = typeof value.tier === 'string' ? value.tier.trim().toUpperCase() : '';
  const coverage = typeof value.coverage === 'string' ? value.coverage.trim().toLowerCase() : '';
  return {
    ...((REVIEW_TIERS as readonly string[]).includes(tier) ? { tier: tier as ReviewTier } : {}),
    entries: textList(value.entries, 20),
    ...(coverage === 'full' || coverage === 'partial' ? { coverage } : {}),
    uncovered: textList(value.uncovered, MAX_FINDINGS),
  };
}

/** Чем отчёт о глубине не дотягивает до того, что ревью закрывается как полное. */
export type ReviewDepthGap = 'unreported' | 'partial' | 'entries' | 'trace';

/**
 * Строка-требование блока ревью: замечания и отчёт о глубине. Одна на все
 * задания ревью — по ссылке, своей работы, повтор итога, — иначе формы
 * разошлись бы и разбор понимал бы одну из них.
 */
export const REVIEW_BLOCK_LINE =
  `End the answer with EXACTLY ONE code block in the language ${REVIEW_BLOCK_LANG} containing ` +
  'JSON like {"findings":["<finding card>", "…"],"depth":{"tier":"T1","entries":["diff-first"],' +
  '"coverage":"full","uncovered":[]}}; no findings — an empty "findings" list with the same ' +
  '"depth" report.';

/** Что осталось от ответа ревьюера после вырезания блоков и что из них разобрано. */
export interface ReviewScan {
  /** Текст, который видит человек: разбор замечаний словами, без служебного блока. */
  text: string;
  /**
   * Вердикт последнего разобранного блока. `undefined` — блока не было вовсе:
   * ревьюер не отчитался, и заводить по такому ответу правки нельзя.
   */
  findings?: string[];
  /** Отчёт о глубине из того же блока, что и `findings`. */
  depth?: ReviewDepth;
  /**
   * Найденное вне охвата группы (`PRE_EXISTING_LINE`, владелец 26.10) — из того же блока.
   * Правкам не уходит никогда: доставка называет его в MR «было до группы, не исправлено».
   */
  preExisting?: string[];
  /** Сколько закрытых блоков разобрать не удалось — иначе отказ не виден. */
  rejected: number;
}

/** `depth` разобранного блока; JSON уже проверен `parseReviewFindings`. */
function depthOf(body: string): ReviewDepth | undefined {
  try {
    return parseReviewDepth((JSON.parse(body) as { depth?: unknown }).depth);
  } catch {
    return undefined;
  }
}

/** `preExisting` разобранного блока: карточки той же длины, что и замечания. */
function preExistingOf(body: string): string[] {
  try {
    return textList((JSON.parse(body) as { preExisting?: unknown }).preExisting, MAX_FINDINGS).map(
      (card) => labelledCut(card, MAX_FINDING_CHARS),
    );
  } catch {
    return [];
  }
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
  let depth: ReviewDepth | undefined;
  let preExisting: string[] = [];
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
      depth = depthOf(body);
      preExisting = preExistingOf(body);
    } else {
      rejected += 1;
      out += rest.slice(open.index + lead, bodyStart + close.index + close[0].length);
    }

    rest = rest.slice(bodyStart + close.index + close[0].length);
  }

  return {
    text: out.replace(/\n{3,}/g, '\n\n').trim(),
    ...(findings ? { findings } : {}),
    ...(depth ? { depth } : {}),
    ...(preExisting.length > 0 ? { preExisting } : {}),
    rejected,
  };
}

/**
 * Как выглядит замечание — одно правило для всех заданий ревью (звено ревью,
 * ревью по ссылке, повтор итога). Все важности, ни одна не отбрасывается
 * «как мелочь»: решает человек, а не обёртка (владелец, 12.10.2026 — прежнее
 * «замечание — только то, что надо исправить» выбрасывало вопросы и мелочи, а
 * «пустой список — лучший ответ» толкало ревью к пустому итогу).
 */
export const FINDING_CARD_LINE =
  'Report EVERY finding at its honest severity — 🔴 blocker, 🟡 should fix, ❓ question, 🟢 optional — ' +
  'none is dropped for being minor. Each finding is a full card in one string, in the finding-card ' +
  'format of the deep-review skill: severity marker, number, a bold thesis, the location as ' +
  'path:start-end, the evidence (the line, the command and its output, or the repro) and what it ' +
  'should be — written so that someone who has not seen this conversation can act on it.';

/**
 * Пустой итог — законный, но только с отчётом о покрытии: «замечаний нет» без
 * сказанного, что прочитано, неотличимо от непрочитанного.
 */
/**
 * Проверки проекта — те, что названы в его правилах, все и по порядку (U7).
 * «Типы, линт, тесты» вообще пропускали гейт документации проекта и
 * backend-гейты: стадия говорила «готово», а CI краснел на том, что правила
 * проекта называли прямо.
 */
export const PROJECT_CHECKS_LINE =
  `Before you say "done", run the project checks its rules name (${RULE_SOURCES}) — all of them,` +
  ' in the order named, frontend and backend alike; no ' +
  'rule names them — whatever the project has (types, lint, tests).';

/** Ссылка вместо определения, когда задание прогона проверки уже назвало (TQ-10). */
const CHECKS_NAMED_IN_TASK =
  'Before you say "done", run the checks your task names, at the scope and moment it names.';

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

/**
 * Границы группы по плану разделения (аудит g8 26.10, N2): правки судили «свою»
 * страницу по диффу ветки и завели 32 записи baseline как «долг страниц других
 * групп» — половина лежала на страницах самой группы, и доставка переделывала их
 * 48 ходами. Мерило — `owns` разбора, а не дифф.
 */
export interface GroupScope {
  /** Что план отдал этой группе. */
  own: string[];
  /** Что план отдал ДРУГИМ группам, без путей, общих с этой. */
  others: string[];
}

/**
 * Вопрос планировщика ревью в группе, где спросить некого (T4). Живая группа
 * на MR 988 получила «ASK: N rounds > 6» и ушла от вопроса подгонкой
 * `--chunk 500 --per-round 8` — тонкий срез диффа на агента вместо вопроса,
 * который некому задать. Решение принято заранее: больше агентов в пределах
 * бюджета, глубина не режется, а упёршийся лимит называется вслух.
 */
export const REVIEW_UNATTENDED_LINE =
  'Nobody answers questions in this group. When the review planner prints "ASK: N rounds > 6" ' +
  '(or any other question meant for a human), take the option with MORE agents per round — never ' +
  'fewer diff lines per agent: do not tune --chunk or --per-round to dodge the question and do not ' +
  'merge tail rounds by hand, the depth the risk tier demands stays whole. The spawn budget of ' +
  'this review is what its plan needs (the agents of every round plus the verifiers); if the ' +
  'session cap on spawns is below that, name in "uncovered" what stays unread because of it, ' +
  'never trim the review silently.';

/**
 * Что ревью обязано помнить после сжатия контекста (T17). Первое сообщение
 * группы после сжатия уходит в пересказ, и вместе с ним — формат карточки
 * замечания (10 тредов подряд в чужом стиле отклонил `review-publish-guard`) и
 * схема отчёта по словам владельца (блок не той схемы не прочитался). Системная
 * дописка в пересказ не уходит; она одна на все ходы звена и не зависит от
 * задания, поэтому совпадает байт в байт у каждого, кто её строит.
 */
export const REVIEW_DURABLE_LINE =
  'Review rules that outlive context compaction (the first message may be summarised away). ' +
  `${FINDING_CARD_LINE} ` +
  'Before the FIRST write of a finding into an MR, re-read the finding-card format of the ' +
  "deep-review skill — never copy the style of other people's threads in that MR. " +
  `${REVIEW_BLOCK_LINE} ` +
  "If the first message carried the owner's request, the answer ALSO ends with a requirement-trace " +
  `block in the language ${blockLang('sieves')}: ` +
  '{"sieves":[{"id":"owner-1","status":"pass|fail|n/a","evidence":"<file:line, the command and a line of its output, or why it does not apply>"}]} ' +
  '— the key is "sieves", every id is the string owner-N, the status is exactly pass, fail or n/a, ' +
  "the evidence at least 12 characters; any other shape is not parsed and the owner's points count as " +
  `not checked. ${REVIEW_UNATTENDED_LINE}`;

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
