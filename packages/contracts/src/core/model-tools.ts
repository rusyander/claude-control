import { z } from 'zod';
import { uuidv7 } from './ids.ts';
import { stepDefId, type CoreStepKind, type StepKind } from './scenario.ts';

/**
 * Инструменты модели — сервер MCP ядра `agentdeck` (03 §Model tools, F04 F10 F16). Схемы строгие:
 * лишнее поле — ошибка поля, недостающее никогда не подставляется значением по умолчанию
 * (P42 для вызова модели). Инструмента публикации, настройки или гранта нет (F23).
 *
 * Сервер `agentdeck-permit` (ответ CLI на вопрос о праве) — отдельный и в списке инструментов
 * модели запрещён (R:S3-09); здесь только его имена — для списка запретов шага.
 */

export const CORE_MCP_SERVER = 'agentdeck';
export const PERMIT_MCP_SERVER = 'agentdeck-permit';
export const PERMIT_TOOL = 'approve';

export const MODEL_TOOL_NAMES = [
  'step_done',
  'check',
  'ask_human',
  'blocker',
  'core_state',
  'unit_diff',
] as const;
export type ModelToolName = (typeof MODEL_TOOL_NAMES)[number];

/**
 * Виды шагов, у которых есть сессия модели (02 §Scenario). `check`, `final-gate`, `publish`,
 * `ask-human` — шаги самого ядра: сессии и инструментов модели у них нет.
 */
export const SESSION_STEP_KINDS = [
  'intake',
  'plan',
  'research',
  'split',
  'work',
  'review',
  'fix',
  'answer-reviewers',
  'report',
  'custom',
] as const;
export type SessionStepKind = (typeof SESSION_STEP_KINDS)[number];

/**
 * Виды сессии и ядра вместе — ровно `STEP_KINDS` сценария, без пересечения: вид без места (или в
 * обоих списках) не соберётся, а не уйдёт в «нет сессии» молча.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const STEP_KINDS_PARTITIONED: Exactly<SessionStepKind | CoreStepKind, StepKind> &
  Exactly<Extract<SessionStepKind, CoreStepKind>, never> = true;
void STEP_KINDS_PARTITIONED;

/**
 * Только чтение (P73): ревью, исследование и отчёт ничего не правят — 02 называет их так;
 * разбор задачи, план и деление тоже (решение 28.10): их итог — вызов инструмента модели и
 * строка журнала, а не файл копии.
 */
const READ_ONLY_KINDS: ReadonlySet<string> = new Set([
  'intake',
  'plan',
  'split',
  'research',
  'review',
  'report',
]);
/** `check` нужен там, где код меняют или судят; отчёт и разбор задачи проверок не зовут. */
const CHECK_KINDS: ReadonlySet<string> = new Set([
  'work',
  'fix',
  'review',
  'answer-reviewers',
  'custom',
]);
/**
 * `unit_diff` — дифф одного файла единицы для тех, кто судит уже сделанную правку: ревью и ответ
 * ревьюерам. Пакет ревью сверх предела называет файлы списком, тело берётся этим инструментом.
 */
const UNIT_DIFF_KINDS: ReadonlySet<string> = new Set(['review', 'answer-reviewers']);

export interface StepToolPlan {
  /** Встроенные инструменты CLI: `read-only` — без правки файлов и без команд, меняющих копию. */
  builtins: 'all' | 'read-only';
  /** Инструменты сервера `agentdeck`, которые видит модель этого шага. */
  modelTools: ModelToolName[];
}

/** Набор инструментов по виду шага; `null` — у вида нет сессии модели (запуск отказан). */
export function toolPlanFor(stepKind: string): StepToolPlan | null {
  if (!(SESSION_STEP_KINDS as readonly string[]).includes(stepKind)) return null;
  const modelTools = MODEL_TOOL_NAMES.filter(
    (t) =>
      (t !== 'check' || CHECK_KINDS.has(stepKind)) &&
      (t !== 'unit_diff' || UNIT_DIFF_KINDS.has(stepKind)),
  );
  return { builtins: READ_ONLY_KINDS.has(stepKind) ? 'read-only' : 'all', modelTools };
}

const line = (max: number) => z.string().min(1).max(max);
/** Номер записи проверки (04 §Records): единственное, чем подтверждается вердикт. */
const recordId = line(200);

/**
 * Заявление о требовании: id — UUIDv7, выданный ядром при извлечении (одно написание, F26, G3);
 * номер «R3» модель не цитирует — неизвестный id — ошибка поля.
 */
export const requirementClaimSchema = z.discriminatedUnion('state', [
  z.strictObject({
    id: uuidv7,
    state: z.literal('covered'),
    evidence: z.array(recordId).min(1).max(50),
  }),
  /** «Не применимо» — с причиной словами, а не с записью; засчитывается только подтверждением ревью. */
  z.strictObject({ id: uuidv7, state: z.literal('n/a'), evidence: line(2000) }),
]);
export type RequirementClaim = z.infer<typeof requirementClaimSchema>;

/** intake / plan: требования, прочитанные из запроса или тикета; id им выдаёт ядро (02:54). */
export const extractedRequirementSchema = z.strictObject({
  text: line(2000),
  source: z.enum(['request', 'ticket']),
});
/** plan / review: источник сверен со списком, недостающее добавлено (02:55, P93). */
export const requirementsReviewSchema = z.strictObject({
  complete: z.boolean(),
  added: z.array(z.strictObject({ text: line(2000) })).max(100),
});
/** review: типизированное подтверждение — единственная дорога для ворот `text` и для n/a (02:57-60). */
export const confirmationSchema = z.strictObject({
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('requirement'), id: uuidv7 }),
    z.strictObject({ kind: z.literal('n/a'), id: uuidv7 }),
    z.strictObject({ kind: z.literal('gate'), stepDefId, index: z.number().int().nonnegative() }),
  ]),
  verdict: z.enum(['confirmed', 'refuted']),
  reason: line(1000),
});
export type Confirmation = z.infer<typeof confirmationSchema>;

const unitProposal = z.strictObject({
  name: line(200),
  ownedPaths: z.array(line(500)).min(1).max(200),
  deps: z.array(line(200)).max(50).optional(),
  estimate: z
    .strictObject({
      minutes: z.number().int().positive().optional(),
      tokens: z.number().int().positive().optional(),
    })
    .optional(),
  /** Ключ или путь репозитория задачи на нескольких репозиториях; нет — единственный репозиторий. */
  repo: line(500).optional(),
  /** Единица-контракт (G19): неявные рёбра ко всем единицам других репозиториев. */
  contract: z.boolean().optional(),
});

/**
 * Цель ревью, которую насчитал разбор (02:19, 02:69): ссылка на MR и, на нескольких репозиториях,
 * его репозиторий. Две и больше — ядро предлагает единицу на цель; одна — деления нет.
 */
const reviewTarget = z.strictObject({
  ref: line(500),
  repo: line(500).optional(),
});
export type ReviewTarget = z.infer<typeof reviewTarget>;

const finding = z.strictObject({
  file: line(500),
  line: z.number().int().positive(),
  severity: z.enum(['blocking', 'major', 'minor', 'nit']),
  text: line(2000),
});

const reply = z.strictObject({ threadId: line(200), text: line(4000), resolve: z.boolean() });

/** Развилка, решённая каноническим значением по умолчанию: уходит в итоговый отчёт (00). */
const fork = z.strictObject({
  question: line(2000),
  options: z.array(line(300)).min(2).max(8),
  chosen: line(300),
  reason: line(1000),
});

export const STEP_DONE_SUMMARY_MAX = 600;
/** Весь вызов целиком в журнале (строка ≤ 16k): подробности сверх — файлом в копии + `handoff`. */
export const STEP_DONE_MAX_CHARS = 15_000;

export const stepDoneSchema = z.strictObject({
  stepId: uuidv7,
  outcome: z.enum(['done', 'partial', 'blocked']),
  requirements: z.array(requirementClaimSchema).max(200),
  units: z.array(unitProposal).min(1).max(20).optional(),
  reviewTargets: z.array(reviewTarget).min(1).max(20).optional(),
  findings: z.array(finding).max(100).optional(),
  replies: z.array(reply).max(100).optional(),
  handoff: line(4000).optional(),
  summary: line(STEP_DONE_SUMMARY_MAX),
  forks: z.array(fork).max(20).optional(),
  extracted: z.array(extractedRequirementSchema).max(200).optional(),
  requirementsReview: requirementsReviewSchema.optional(),
  confirmations: z.array(confirmationSchema).max(200).optional(),
});
export type StepDoneCall = z.infer<typeof stepDoneSchema>;

type KindBoundField =
  | 'units'
  | 'reviewTargets'
  | 'findings'
  | 'replies'
  | 'extracted'
  | 'requirementsReview'
  | 'confirmations';
/**
 * Поля, которые годятся не каждому виду шага: замечания — только ревью, ответы в обсуждения —
 * только ответу ревьюерам, деление на единицы — только плану и разделению, цели ревью — только
 * разбору; извлечение требований — разбору и плану, сверка извлечения — плану и ревью,
 * подтверждения — только ревью (G4).
 */
export const STEP_DONE_KIND_FIELDS: Record<KindBoundField, readonly SessionStepKind[]> = {
  units: ['plan', 'split'],
  reviewTargets: ['intake'],
  findings: ['review'],
  replies: ['answer-reviewers'],
  extracted: ['intake', 'plan'],
  requirementsReview: ['plan', 'review'],
  confirmations: ['review'],
};

/** Коды ошибок поля доказательства в ответе `step_done` (зона C): раз — список, потом отказ (P72). */
export const STEP_DONE_EVIDENCE_CODES = [
  'unknown-requirement',
  /** Ключ записи ≠ `keyOf` на текущем дереве (F-051, G22). */
  'stale-evidence',
  /** Замыкание ∩ изменённые файлы пусто, или статическая запись для требования поведения (P92). */
  'irrelevant-evidence',
  /** Происхождение записи ≠ `core` (02:61). */
  'captured-evidence',
] as const;
export type StepDoneEvidenceCode = (typeof STEP_DONE_EVIDENCE_CODES)[number];

export const checkCallSchema = z
  .strictObject({
    checkId: line(200).optional(),
    argv: z.array(z.string().max(4000)).min(1).max(200).optional(),
    scope: z.array(line(500)).max(200).optional(),
  })
  .refine((v) => (v.checkId === undefined) !== (v.argv === undefined), {
    message: 'exactly one of checkId, argv',
  });
export type CheckCall = z.infer<typeof checkCallSchema>;

/**
 * Типизированное действие вопроса (06 §Human points): закрытый список решает по виду действия,
 * а не по тексту вопроса (прозу ядро не разбирает, R:S3-12). Без действия вопрос — вне списка.
 */
export const ASK_ACTION_KINDS = [
  'merge',
  'remote-delete',
  'foreign-copy-delete',
  'db-write',
  'service-endpoint',
  'credential',
  'access-grant',
  'integration',
  'path',
  'action-class',
  'tracker-write',
  'forge-write',
] as const;
export type AskActionKind = (typeof ASK_ACTION_KINDS)[number];

export const askHumanSchema = z
  .strictObject({
    question: line(2000),
    options: z.array(line(300)).min(2).max(8),
    recommendation: line(300),
    blocking: z.boolean(),
    action: z.strictObject({ kind: z.enum(ASK_ACTION_KINDS), target: line(500) }).optional(),
  })
  .refine((v) => v.options.includes(v.recommendation), {
    message: 'recommendation must be one of options',
    path: ['recommendation'],
  });
export type AskHumanCall = z.infer<typeof askHumanSchema>;

export const BLOCKER_KINDS = ['env', 'access', 'external', 'requirement-conflict'] as const;
export const blockerSchema = z.strictObject({
  kind: z.enum(BLOCKER_KINDS),
  detail: line(4000),
});
export type BlockerCall = z.infer<typeof blockerSchema>;

export const coreStateSchema = z.strictObject({});

/** Путь файла из пакета ревью — относительный к копии единицы. */
export const unitDiffSchema = z.strictObject({ file: z.string().min(1).max(4096) });
export type UnitDiffCall = z.infer<typeof unitDiffSchema>;

export const MODEL_TOOL_SCHEMAS = {
  step_done: stepDoneSchema,
  check: checkCallSchema,
  ask_human: askHumanSchema,
  blocker: blockerSchema,
  core_state: coreStateSchema,
  unit_diff: unitDiffSchema,
} as const satisfies Record<ModelToolName, z.ZodType>;

/** Описания для `tools/list` — модель читает их, поэтому по-английски (как и ответы). */
export const MODEL_TOOL_DESCRIPTIONS: Record<ModelToolName, string> = {
  step_done:
    'Finish the current step with typed claims. Every covered requirement cites green check record ids; ' +
    'an invalid call returns its field errors once, a repeated invalid call is counted as a refusal.',
  check:
    'Ask the core to run or replay a registry check: by checkId, or by an argv that matches a registry ' +
    'check (any other argv is refused as not-registered and runs nothing). The result carries the ' +
    'verdict, a failing excerpt, the record id and the log path.',
  ask_human:
    'Ask the human. Only actions on the closed human-point list (typed `action`) block; anything else ' +
    'continues with your recommendation and lands in the final report.',
  blocker:
    'Report what stops the step: env, access, external or requirement-conflict, with the detail.',
  core_state: 'Read the core state of this step: task, unit, step, open asks.',
  unit_diff:
    'Read the diff of one file of the reviewed unit against its base. Only files listed in the ' +
    'review pack; the body is masked and, when long, cut with a marker naming where to read on.',
};

export type FieldIssueCode = 'unknown-field' | 'missing-field' | 'invalid-field';
export interface FieldIssue {
  path: string;
  code: FieldIssueCode;
  message: string;
}

/** Ответ ядра на вызов инструмента модели: исход или отказ с кодом (и полями — один раз, P72). */
export type ModelToolReply =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string; issues?: FieldIssue[] };

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let at = root;
  for (const key of path) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<PropertyKey, unknown>)[key];
  }
  return at;
}

/** Проблемы zod → поля с путём: нет поля во входе — «нет поля», а не «плохое значение». */
export function fieldIssues(issues: readonly z.core.$ZodIssue[], root: unknown): FieldIssue[] {
  return issues.flatMap((issue): FieldIssue[] => {
    const base = issue.path.map(String).join('.');
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: [base, key].filter(Boolean).join('.'),
        code: 'unknown-field',
        message: 'unknown field',
      }));
    }
    const missing = issue.path.length > 0 && valueAt(root, issue.path) === undefined;
    return [
      { path: base, code: missing ? 'missing-field' : 'invalid-field', message: issue.message },
    ];
  });
}

export type ParsedCall<T> = { ok: true; value: T } | { ok: false; issues: FieldIssue[] };

export function parseModelCall<N extends ModelToolName>(
  name: N,
  input: unknown,
): ParsedCall<z.infer<(typeof MODEL_TOOL_SCHEMAS)[N]>> {
  const parsed = MODEL_TOOL_SCHEMAS[name].safeParse(input);
  if (!parsed.success) return { ok: false, issues: fieldIssues(parsed.error.issues, input) };
  return { ok: true, value: parsed.data as z.infer<(typeof MODEL_TOOL_SCHEMAS)[N]> };
}

/** `step_done` строго по виду шага: чужие виду поля и превышение размера — ошибки полей. */
export function parseStepDone(input: unknown, stepKind: string): ParsedCall<StepDoneCall> {
  const parsed = parseModelCall('step_done', input);
  if (!parsed.ok) return parsed;
  const issues: FieldIssue[] = [];
  for (const [field, kinds] of Object.entries(STEP_DONE_KIND_FIELDS)) {
    const allowed = (kinds as readonly string[]).includes(stepKind);
    if (parsed.value[field as keyof StepDoneCall] !== undefined && !allowed) {
      issues.push({
        path: field,
        code: 'invalid-field',
        message: `not allowed for step kind ${stepKind} (only ${kinds.join(', ')})`,
      });
    }
  }
  const size = JSON.stringify(parsed.value).length;
  if (size > STEP_DONE_MAX_CHARS) {
    issues.push({
      path: '',
      code: 'invalid-field',
      message: `call is ${size} chars, max ${STEP_DONE_MAX_CHARS}: move detail into a file and name it in handoff`,
    });
  }
  return issues.length ? { ok: false, issues } : parsed;
}

/** JSON-схема входа для `tools/list` (MCP `inputSchema`). */
export function inputSchemaOf(name: ModelToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(MODEL_TOOL_SCHEMAS[name], { unrepresentable: 'any' });
  const { $schema: _drop, ...rest } = schema as Record<string, unknown>;
  return rest;
}
