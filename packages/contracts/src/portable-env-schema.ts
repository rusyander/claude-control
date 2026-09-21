import {
  object,
  string,
  array,
  number,
  boolean,
  literal,
  union,
  discriminatedUnion,
  enum as zodEnum,
  type infer as Infer,
} from 'zod';
import type { AgentEnvironment } from './portable-env.ts';
import {
  attachmentSkipReasons,
  CANON_VERSION,
  envBlockings,
  envItemKinds,
  envNeeds,
  envOrigins,
  envScopes,
  envSideEffects,
  envSkipReasons,
  mcpTransports,
  needsEvidences,
  pluginForms,
  sessionEvents,
  toolEvents,
} from './portable-env.ts';

/**
 * Проверка канона переносимой среды — отдельно от словаря (`portable-env.ts`) и
 * по той же причине, по какой отделены схемы правил: сервер импортирует словарь
 * напрямую под `--experimental-strip-types`, где zod ему не нужен, а вебу и
 * маршрутам нужен разбор недоверенного входа.
 *
 * Разбор FAIL-CLOSED (инвариант 3 партии): незнакомый вид записи, незнакомое
 * значение `needs` или пустой список фактов — это отказ, а не запись наугад.
 * Именно поэтому здесь всюду закрытые наборы из словаря, а не `string()`: новое
 * значение невозможно ввести мимо словаря ни типом, ни разбором.
 */

/** Требования к рантайму: три исхода, и `facts` не бывает пустым. */
export const envNeedsSchema = union([
  object({
    resolution: literal('facts'),
    /** Минимум один факт: пустой список здесь означал бы «ничего не нужно» молча. */
    facts: array(zodEnum(envNeeds)).min(1),
    evidence: zodEnum(needsEvidences),
  }),
  object({ resolution: literal('none'), why: string().min(1) }),
  object({ resolution: literal('undetermined'), why: string().min(1) }),
]);

export type EnvNeedsShape = Infer<typeof envNeedsSchema>;

export const envTriggerSchema = discriminatedUnion('on', [
  object({ on: literal('session'), event: zodEnum(sessionEvents) }),
  object({ on: literal('tool'), event: zodEnum(toolEvents), match: string().nullable() }),
  object({ on: literal('prompt') }),
  object({ on: literal('model') }),
  object({ on: literal('user') }),
  object({ on: literal('always') }),
]);

export const envSourceSchema = object({
  provider: string().min(1),
  scope: zodEnum(envScopes),
  origin: zodEnum(envOrigins),
  file: string().nullable(),
  /** Плагин-источник записи (`<плагин>@<магазин>`); `null` — запись человека. */
  plugin: string().nullable(),
});

/** Общая часть записи; `kind` добавляет каждый вид сам — по нему идёт разметка объединения. */
const itemBase = {
  id: string().min(1),
  source: envSourceSchema,
  intent: string().min(1),
  trigger: envTriggerSchema,
  blocking: zodEnum(envBlockings),
  needs: envNeedsSchema,
  sideEffects: array(zodEnum(envSideEffects)),
};

/** Исходный кусок источника: есть у всех видов, кроме секрета. */
const raw = { raw: string() };

export const instructionsItemSchema = object({
  kind: literal('instructions'),
  fileName: string().min(1),
  text: string(),
  includes: array(string()),
  legacy: boolean(),
  enabled: boolean(),
  ...itemBase,
  ...raw,
});

/** Вложение скилла: опись, а не содержимое (П2.6). */
export const skillAttachmentSchema = object({
  path: string().min(1),
  bytes: number().int().nonnegative(),
  sha256: string().min(1),
});

/** Вложение, которое не поехало: имя файла и причина из закрытого словаря. */
export const skillAttachmentSkipSchema = object({
  path: string().min(1),
  bytes: number().int().nonnegative(),
  reason: zodEnum(attachmentSkipReasons),
});

export const skillItemSchema = object({
  kind: literal('skill'),
  name: string().min(1),
  description: string(),
  body: string(),
  dir: string().nullable(),
  enabled: boolean(),
  attachments: array(skillAttachmentSchema),
  attachmentsSkipped: array(skillAttachmentSkipSchema),
  ...itemBase,
  ...raw,
});

export const commandItemSchema = object({
  kind: literal('command'),
  name: string().min(1),
  namespace: string().nullable(),
  description: string(),
  prompt: string(),
  ...itemBase,
  ...raw,
});

export const subagentItemSchema = object({
  kind: literal('subagent'),
  name: string().min(1),
  description: string(),
  tools: array(string()).nullable(),
  model: string().nullable(),
  omitInstructions: boolean(),
  ...itemBase,
  ...raw,
});

export const hookItemSchema = object({
  kind: literal('hook'),
  command: string().min(1),
  scriptPath: string().nullable(),
  timeout: object({ value: number(), unit: union([literal('ms'), literal('s')]) }).nullable(),
  enabled: boolean(),
  ...itemBase,
  ...raw,
});

export const permissionItemSchema = object({
  kind: literal('permission'),
  rule: string().min(1),
  decision: union([literal('allow'), literal('ask'), literal('deny')]),
  order: number().int(),
  enabled: boolean(),
  ...itemBase,
  ...raw,
});

export const mcpServerItemSchema = object({
  kind: literal('mcpServer'),
  name: string().min(1),
  transport: zodEnum(mcpTransports),
  command: string().nullable(),
  args: array(string()),
  url: string().nullable(),
  /** Имена ключей окружения, не значения: значение секрета в канон не попадает. */
  envKeys: array(string()),
  enabled: boolean(),
  ...itemBase,
  ...raw,
});

export const envVarItemSchema = object({
  kind: literal('envVar'),
  name: string().min(1),
  value: string(),
  ...itemBase,
  ...raw,
});

export const secretItemSchema = object({
  kind: literal('secret'),
  name: string().min(1),
  mask: string(),
  holder: union([literal('panel'), literal('provider')]),
  ...itemBase,
});

export const pluginItemSchema = object({
  kind: literal('plugin'),
  name: string().min(1),
  version: string().nullable(),
  form: zodEnum(pluginForms),
  readOnly: boolean(),
  provides: array(zodEnum(envItemKinds)),
  enabled: boolean(),
  ...itemBase,
  ...raw,
});

export const panelGroupItemSchema = object({
  kind: literal('panelGroup'),
  name: string().min(1),
  description: string(),
  members: array(string()),
  ...itemBase,
  ...raw,
});

export const conversationItemSchema = object({
  kind: literal('conversation'),
  title: string(),
  turns: number().int().nonnegative(),
  lastActiveIso: string(),
  workdir: string().nullable(),
  ...itemBase,
  ...raw,
});

/** Запись канона: вид решает форму, незнакомый вид — отказ разбора. */
export const envItemSchema = discriminatedUnion('kind', [
  instructionsItemSchema,
  skillItemSchema,
  commandItemSchema,
  subagentItemSchema,
  hookItemSchema,
  permissionItemSchema,
  mcpServerItemSchema,
  envVarItemSchema,
  secretItemSchema,
  pluginItemSchema,
  panelGroupItemSchema,
  conversationItemSchema,
]);

/** Рубильник раздела источника: состояние, а не пропуск (П2.6). */
export const envSectionStateSchema = object({
  kind: zodEnum(envItemKinds),
  enabled: boolean(),
  detail: string(),
});

export const envSkipSchema = object({
  kind: zodEnum(envItemKinds),
  reason: zodEnum(envSkipReasons),
  detail: string(),
});

/**
 * Паспорт среды. Версия канона разбирается литералом: паспорт другой версии не
 * «почти читается», а отвергается — дальше с ним разбирается
 * `checkCanonVersion`, который объясняет человеку, старше словарь или младше.
 */
export const agentEnvironmentSchema = object({
  canonVersion: literal(CANON_VERSION),
  provider: string().min(1),
  scope: zodEnum(envScopes),
  root: string(),
  capturedAt: string(),
  items: array(envItemSchema),
  skipped: array(envSkipSchema),
  sectionStates: array(envSectionStateSchema),
});

export type AgentEnvironmentShape = Infer<typeof agentEnvironmentSchema>;

/**
 * Разобрать недоверенный паспорт и получить его КАНОНОМ, а не формой схемы.
 *
 * Разница между `AgentEnvironmentShape` и `AgentEnvironment` ровно одна и она
 * статическая: словарь объявляет `needs.facts` непустым кортежем
 * (`[EnvNeed, ...EnvNeed[]]`) — это и есть запрет на молчаливое «ничего не
 * нужно», — а zod 4 типизирует `array(...).min(1)` обычным массивом. ПРОВЕРКА
 * при этом та же: пустой список отвергается разбором, и до `as` доезжает только
 * то, что её прошло.
 *
 * Функция существует, чтобы приведение было ОДНО и с объяснением. Разбор на
 * стороне вызывающего заканчивался бы его собственным `as` — по одному в каждом
 * месте, без проверки и без этой строки.
 */
export function parseAgentEnvironment(input: unknown): AgentEnvironment {
  return agentEnvironmentSchema.parse(input) as AgentEnvironment;
}
