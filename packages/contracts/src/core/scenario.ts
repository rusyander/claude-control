import { z } from 'zod';
import { registryId } from './ids.ts';
import { allowedRouteSchema } from './route-schema.ts';

/**
 * Сценарий задачи (02 §Scenario, 00 §Precedence): шаги, их знания, модель, проверки, ворота и
 * пределы. Каждый объект строгий (P42/P45): лишнее поле — ошибка, недостающее не подставляется.
 * Модуль читают и ядро, и редактор панели — `scenarioProblems` один на обоих.
 */

const line = (max: number) => z.string().min(1).max(max);
const pos = z.number().int().positive();
const checkId = line(200);

export const STEP_KINDS = [
  'intake',
  'plan',
  'research',
  'split',
  'work',
  'check',
  'review',
  'fix',
  'final-gate',
  'publish',
  'answer-reviewers',
  'report',
  'ask-human',
  'custom',
  /**
   * Разговор с человеком (этап 10, чат панели над ядром): сессия ждёт между ходами человека и
   * кончается только командой `end-chat` или отменой задачи — конец хода не повод напоминать.
   */
  'chat',
  /**
   * Проход по стенду (этап 12, D23): сессия водит браузер только инструментами ядра, каждое
   * действие — строка `browse.step`; копию не правит.
   */
  'walk',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];
/**
 * Шаги самого ядра — без сессии модели; дополнение `SESSION_STEP_KINDS` (`model-tools.ts`), их
 * объединение = `STEP_KINDS` — это проверяет тип там же, новый вид без места не соберётся.
 */
export const CORE_STEP_KINDS = ['check', 'final-gate', 'publish', 'ask-human'] as const;
export type CoreStepKind = (typeof CORE_STEP_KINDS)[number];

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const slug = (what: string) => z.string().regex(SLUG, what);
export const stepDefId = slug('step id');
export const scenarioId = slug('scenario id');

export const gateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('requirements-covered') }),
  z.strictObject({ kind: z.literal('check-green'), checkId }),
  z.strictObject({ kind: z.literal('regression-red-before') }),
  z.strictObject({ kind: z.literal('review-no-blocking') }),
  /** Закрывается только типизированным подтверждением шага ревью (F16): проза его не закрывает. */
  z.strictObject({ kind: z.literal('text'), criterion: line(2000) }),
]);
export type Gate = z.infer<typeof gateSchema>;
export type GateKind = Gate['kind'];

/**
 * Порядки ширины, узкое первым (00 §Precedence): уровни 4/5 двигают ключ только к индексу 0 или
 * добавляют пункты списка; шаг от нуля — расширение, отказ с именем (P65). `hooks: on` оставляет
 * хуки пользователя — это самое узкое.
 */
export const MODEL_TIERS = ['lower-if-mechanical', 'ceiling', 'raise-for-planning'] as const;
export const OVER_BUDGET = ['stop', 'ask', 'once-more'] as const;
export const LAYER_HOOKS = ['on', 'observe', 'off'] as const;
export const LAYER_SKILLS = ['on', 'off'] as const;
export const MID_CHECKS = ['narrow', 'none'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Класс задачи ведущего (этап 11, P134): S — одна правка, XL — много единиц со связями. Живёт
 * здесь, а не в `lead.ts`: шаг сценария ограничивается классами (`onlyFor`), а `lead.ts` сам
 * читает `MODEL_TIERS` отсюда — иначе модули ссылались бы друг на друга.
 */
export const TASK_CLASSES = ['S', 'M', 'L', 'XL'] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

/**
 * Профили ведущего (этап 11) — здесь по той же причине, что классы: шаг ограничивается профилем
 * (`onlyProfile`, этап 12 D25), а `lead.ts` читает этот модуль и отдаёт список дальше.
 */
export const LEAD_PROFILES = ['economy', 'balanced', 'max-quality'] as const;
export type LeadProfile = (typeof LEAD_PROFILES)[number];

/**
 * Уровень модели нового шага по виду (канон пресетов): план — выше, механика ядра — ниже,
 * остальное — потолок. Один на ядро и панель: редактор сценария ставит шагу тот же уровень, что
 * дали бы пресеты, а расхождение копий меняло бы цену шага молча.
 */
export const STEP_TIER_OF: Readonly<Record<StepKind, ModelTier>> = {
  intake: 'ceiling',
  plan: 'raise-for-planning',
  research: 'ceiling',
  split: 'raise-for-planning',
  work: 'ceiling',
  check: 'lower-if-mechanical',
  review: 'ceiling',
  fix: 'ceiling',
  'final-gate': 'lower-if-mechanical',
  publish: 'lower-if-mechanical',
  'answer-reviewers': 'ceiling',
  report: 'ceiling',
  'ask-human': 'lower-if-mechanical',
  custom: 'ceiling',
  chat: 'ceiling',
  // Проход судит, похоже ли поведение страницы на ожидаемое, — это работа, а не механика.
  walk: 'ceiling',
};
export type OverBudget = (typeof OVER_BUDGET)[number];
export const WIDTH_ORDER = {
  'model.tier': MODEL_TIERS,
  overBudget: OVER_BUDGET,
  'userLayer.hooks': LAYER_HOOKS,
  'userLayer.skills': LAYER_SKILLS,
  'checks.mid': MID_CHECKS,
} as const;
/** Числовые ключи: меньше — уже. Нет бюджета — без предела, то есть шире всего. */
export const NUMERIC_NARROW_KEYS = ['roundCap', 'budget.tokens', 'budget.minutes'] as const;
/** Списки: надмножество — уже (больше проверок и ворот); `model.routes` — подмножество уже (R:PR-16). */
export const SUPERSET_KEYS = ['checks.required', 'gate'] as const;
export const SUBSET_KEYS = ['model.routes'] as const;
/** Все ключи, которые уровни 4/5 вправе сужать; путь вне списка — отказ с именем, не молчание. */
export type NarrowKey =
  | keyof typeof WIDTH_ORDER
  | (typeof NUMERIC_NARROW_KEYS)[number]
  | (typeof SUPERSET_KEYS)[number]
  | (typeof SUBSET_KEYS)[number];

const budgetSchema = z.strictObject({ tokens: pos.optional(), minutes: pos.optional() });
const modelSchema = z.strictObject({
  tier: z.enum(MODEL_TIERS),
  effort: registryId.optional(),
  routes: z.array(allowedRouteSchema).min(1).optional(),
});
const userLayerSchema = z.strictObject({
  hooks: z.enum(LAYER_HOOKS),
  skills: z.enum(LAYER_SKILLS),
});
const checksSchema = z.strictObject({
  mid: z.enum(MID_CHECKS),
  required: z.array(checkId).max(100),
});
const roundCapSchema = z.number().int().min(0).max(10);

export const ROUND_CAP_DEFAULT = 2;

export const stepDefSchema = z.strictObject({
  id: stepDefId,
  kind: z.enum(STEP_KINDS),
  title: line(200),
  after: z.array(stepDefId).max(16),
  /** Подшаг навыка из `within` «Пути» (02:26); вид тогда — `work`. */
  within: z
    .strictObject({
      skillId: registryId,
      index: z.number().int().min(-1),
      after: z.string().max(200),
    })
    .optional(),
  knowledge: z.strictObject({
    skills: z.array(registryId).max(50),
    rules: z.array(registryId).max(50),
    hooks: z.array(registryId).max(50),
    scripts: z.array(registryId).max(50),
    text: z.string().max(16_000).optional(),
  }),
  model: modelSchema,
  checks: checksSchema,
  /** review: круги ревью⇄правка; work/fix/custom: повторные входы по красному и без исхода (G14). */
  roundCap: roundCapSchema,
  budget: budgetSchema,
  overBudget: z.enum(OVER_BUDGET),
  userLayer: userLayerSchema,
  gate: z.array(gateSchema).max(20),
  /** Только вид `ask-human` (точка человека 8). */
  ask: z
    .strictObject({
      question: line(2000),
      options: z.array(line(300)).min(2).max(8),
      recommendation: line(300),
    })
    .optional(),
  /** Вид `work` в исправлении ошибки: тест регрессии, который ядро гонит «красным до» (02:16-17, P94). */
  regression: z.strictObject({ checkId }).optional(),
  /** Только вид `publish`: черновик или готовый MR решает сценарий (05:70); нет поля — готовый. */
  publish: z.strictObject({ draft: z.boolean().optional() }).optional(),
  /**
   * Этап 11 (P134): шаг идёт только у задач этих классов; у прочих ведущий его пропускает
   * (`skip-step`). Нет поля — шаг для всех классов; пустой список — ошибка автора, а не «никогда».
   */
  onlyFor: z.array(z.enum(TASK_CLASSES)).min(1).max(TASK_CLASSES.length).optional(),
  /**
   * Этап 12 (D25, P185): шаг идёт только под этими профилями ведущего; под прочими — пропуск
   * (`skip-step`) с причиной. Нет поля — под любым профилем.
   */
  onlyProfile: z.array(z.enum(LEAD_PROFILES)).min(1).max(LEAD_PROFILES.length).optional(),
  /**
   * Этап 12 (D25): второе ревью шага `crossOf` — маршрут выбирается в обход адаптера его сессии
   * (`avoidAdapter`); другого адаптера в наборе нет — шаг пропускается с причиной в отчёте.
   */
  crossOf: stepDefId.optional(),
});
export type StepDef = z.infer<typeof stepDefSchema>;

export const scenarioRefSchema = z.strictObject({ id: scenarioId, version: pos });
export type ScenarioRef = z.infer<typeof scenarioRefSchema>;

export const scenarioSchema = z.strictObject({
  id: scenarioId,
  version: pos,
  title: line(200),
  presetOf: scenarioRefSchema.optional(),
  steps: z.array(stepDefSchema).min(1).max(64),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export const PRESET_IDS = [
  'bug-fix',
  'feature',
  'refactor',
  'review-only',
  'tracker-ticket',
  /** Открывает опрос форжа (05:77): поздние заметки ревьюеров в MR законченной задачи. */
  'answer-reviewers',
  /**
   * Чат панели (этап 10): один шаг `chat`, без хвоста доставки и без оценки; публикация — только
   * через вопрос человеку. Место — копия, основная копия проекта — только с грантом (06:98).
   */
  'chat',
  /**
   * Лёгкая сессия «ask» (этап 10, F2): один ход без репозитория во временном каталоге ядра,
   * без встроенных инструментов. Создаётся только `POST /v1/ask`, оценка его отказывает.
   */
  'ask',
  /**
   * Ревью MR по ссылке (этап 10, F8 — перенос карточки ревью старой панели): единица 0 — копия
   * на ветке MR, после ревью человек решает «починить / отписать / оба / ничего», пуш — отдельным
   * вопросом. Создаётся только `POST /v1/review-link` (нужна личность MR), оценка его отказывает.
   */
  'review-link',
  /**
   * Ведущий (этап 11, P133-P137): разведка → карточка разбора → класс S/M/L/XL решает форму —
   * план только у M и шире, ревью у каждого класса. `tracker-ticket` — тот же ведущий с источником
   * трекера.
   */
  'lead',
  /**
   * Проход по стенду (этап 12, D23–D24): один шаг `walk` без хвоста доставки — копию не правит,
   * итог — строки `browse.step` (из них панель собирает спек) и отчёт о найденном.
   */
  'browser-walk',
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/**
 * Структурные проблемы сценария (чистая функция; ядро и редактор панели — одна). Правила уровня 1
 * (00 §Precedence 1): публикация и ответ ревьюерам — только после финальных ворот. Пусто — годен.
 */
export function scenarioProblems(s: Scenario): string[] {
  const out: string[] = [];
  const byId = new Map(s.steps.map((st) => [st.id, st]));
  if (byId.size !== s.steps.length) out.push('duplicate step id');
  for (const st of s.steps) {
    for (const dep of st.after) if (!byId.has(dep)) out.push(`${st.id}: after unknown step ${dep}`);
    if ((st.kind === 'ask-human') !== (st.ask !== undefined))
      out.push(`${st.id}: ask ⇔ kind ask-human`);
    // Рекомендация вне вариантов — тот же отказ, что у `ask_human` модели: человеку нечего выбрать.
    if (st.ask && !st.ask.options.includes(st.ask.recommendation))
      out.push(`${st.id}: ask recommendation is not one of options`);
    if (st.within && st.kind !== 'work') out.push(`${st.id}: within needs kind work`);
    if (st.regression && st.kind !== 'work') out.push(`${st.id}: regression needs kind work`);
    if (st.crossOf !== undefined) {
      // Второе ревью судит то же, что первое, — оба шага ревью, и не сам себя.
      if (st.kind !== 'review') out.push(`${st.id}: crossOf needs kind review`);
      const of = byId.get(st.crossOf);
      if (!of || of.kind !== 'review' || of.id === st.id)
        out.push(`${st.id}: crossOf must name another review step`);
    }
  }
  const onPath = new Set<string>();
  const ancestors = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    const known = ancestors.get(id);
    if (known) return known;
    if (onPath.has(id)) {
      out.push(`cycle through ${id}`);
      return new Set();
    }
    onPath.add(id);
    const acc = new Set<string>();
    for (const dep of byId.get(id)?.after ?? []) {
      acc.add(dep);
      for (const a of visit(dep)) acc.add(a);
    }
    onPath.delete(id);
    ancestors.set(id, acc);
    return acc;
  };
  for (const st of s.steps) {
    const anc = visit(st.id);
    // Адаптер первого ревью известен, только когда оно уже прошло: второе идёт после него.
    if (st.crossOf !== undefined && byId.has(st.crossOf) && !anc.has(st.crossOf))
      out.push(`${st.id}: crossOf step ${st.crossOf} must run before it`);
    if (st.kind === 'publish' || st.kind === 'answer-reviewers') {
      const gated = [...anc].some((a) => byId.get(a)?.kind === 'final-gate');
      if (!gated) out.push(`${st.id}: ${st.kind} without a final-gate before it`);
    }
  }
  return [...new Set(out)];
}

/** Ключ правки шага в файле проекта: id шага сценария или `*` — каждый шаг. */
const STEP_KEY = /^(\*|[a-z0-9][a-z0-9-]{0,63})$/;

/** Файл проекта уровня 4 `<repo>/.agentdeck/scenario.json` (02:29-32): только сужает, ядро его не пишет. */
const stepNarrowing = z.strictObject({
  checks: z
    .strictObject({
      mid: z.enum(MID_CHECKS).optional(),
      required: z.array(checkId).max(100).optional(),
    })
    .optional(),
  roundCap: roundCapSchema.optional(),
  budget: budgetSchema.optional(),
  overBudget: z.enum(OVER_BUDGET).optional(),
  model: z
    .strictObject({
      tier: z.enum(MODEL_TIERS).optional(),
      routes: z.array(allowedRouteSchema).min(1).optional(),
    })
    .optional(),
  userLayer: z
    .strictObject({
      hooks: z.enum(LAYER_HOOKS).optional(),
      skills: z.enum(LAYER_SKILLS).optional(),
    })
    .optional(),
  gate: z.array(gateSchema).max(20).optional(),
});
export type StepNarrowing = z.infer<typeof stepNarrowing>;

export const projectScenarioSchema = z.strictObject({
  v: z.literal(1),
  steps: z.record(z.string().regex(STEP_KEY, 'step id or *'), stepNarrowing).optional(),
  /** Только добавленные шаги ядра (`check`, `ask-human`): добавить проверку или вопрос — сузить. */
  insert: z.array(stepDefSchema).max(10).optional(),
  /**
   * Принимается формой, чтобы отказать И назвать (R:S1-09: ждать CI — живое решение человека,
   * не файла проекта).
   */
  ciWait: z.unknown().optional(),
});
export type ProjectScenario = z.infer<typeof projectScenarioSchema>;

/** Уровень правки сценария (00 §Precedence): 3 — библиотека/пресет, 4 — проект, 5 — слой пользователя (чтение с фазы 7, G13). */
export const OVERLAY_LEVELS = [3, 4, 5] as const;
export const overlayEntrySchema = z.strictObject({
  level: z.literal(OVERLAY_LEVELS),
  path: line(300),
  value: z.json(),
  reason: z.string().max(1000),
});
export type OverlayEntry = z.infer<typeof overlayEntrySchema>;
