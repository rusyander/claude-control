import { z } from 'zod';
import { registryId, sha256Hex, uuidv7 } from './ids.ts';
import { DECISION_CLASS_IDS } from './decisions.ts';
import { stepDoneSchema } from './model-tools.ts';
import type { CheckEntryRoad, RecordGrade, RecordOrigin } from './records.ts';
import {
  ASK_MACHINE,
  CHECK_MACHINE,
  PUBLISH_MACHINE,
  SESSION_MACHINE,
  STEP_MACHINE,
  TASK_MACHINE,
  UNIT_MACHINE,
  type MachineDef,
} from './states.ts';

/**
 * Данные каждого вида события журнала, версия 1 (01 §Journal). Каждый объект строгий: лишнее
 * поле — отказ, а не молчаливое расширение (P45). Имени CLI, провайдера или модели здесь нет ни
 * одного: переходник, маршрут и модель — данные из реестра (владелец, 28.10).
 */

const int = z.number().int();
const nonNeg = int.nonnegative();
const text = z.string().max(16_000);
const json = z.json();
/**
 * Время старта процесса — строка в той форме, в какой её отдаёт ОС (платформа ядра, 09):
 * личность процесса = pid + эта строка, сравнение только на равенство.
 */
const processStart = z.string().min(1).max(64);

function transition<S extends string, E extends string, K extends string>(
  machine: MachineDef<S, E>,
  idField: K,
) {
  const id = { [idField]: uuidv7 } as { [P in K]: typeof uuidv7 };
  return z.strictObject({
    ...id,
    event: z.enum(machine.events as unknown as [E, ...E[]]),
    from: z.enum(machine.states as unknown as [S, ...S[]]),
    to: z.enum(machine.states as unknown as [S, ...S[]]),
  });
}

/**
 * Куда идут запросы модели и кто держит доступ (11 §Two axes): собственный вход CLI, ключ API,
 * локальный сервер моделей, шлюз контура или заглушка. Заглушка — такой же маршрут, а не особый
 * случай (владелец, 28.10). `id` — из реестра маршрутов (`cli-login:<adapter>`, `local:own`…).
 */
export const ROUTE_KINDS = ['cli-login', 'api-key', 'local', 'gateway', 'stub'] as const;
export const routeSchema = z.strictObject({ kind: z.enum(ROUTE_KINDS), id: registryId });

/** Где лежит доступ сессии — только вид, значение никогда не попадает в журнал (11 §Policy). */
export const CREDENTIAL_KINDS = [
  'cli-store',
  'panel-store',
  'env',
  'hop-injected',
  'none',
] as const;

/** Вид предела маршрута (11 §Economy): окно подписки, частота, бюджет, слот локального сервера. */
export const LIMIT_KINDS = ['window', 'rate', 'budget', 'slot'] as const;

/** Разрешённая тройка (переходник, маршрут, шаблон модели) (11 §Policy). */
export const allowedRouteSchema = z.strictObject({
  adapter: registryId,
  route: routeSchema,
  modelPattern: z.string().min(1).max(200),
});

/** Уровень, давший набор маршрутов (06 §Precedence: 0 — встроенное … 5 — команда человека). */
const sourceLevel = z.number().int().min(0).max(5);

export const ACTION_KINDS = [
  'push',
  'mr-create',
  'mr-update',
  'thread-reply',
  'tracker-write',
  'container-start',
  'container-remove',
  'process-start',
  'copy-create',
  'copy-remove',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const RESOURCE_KINDS = [
  'copy',
  'branch',
  'process',
  'container',
  'volume',
  'port',
  'stand',
  'tmpdir',
  'lease',
  'copy-session',
  'model-server',
  'model-slot',
  'model-load',
  'hop',
  'stub-server',
] as const;

const layerMode = z.enum(['on', 'observe', 'off']);
const sessionLayer = z.strictObject({
  asked: layerMode,
  ran: layerMode,
  /** Файлы настроек репозитория (хуки, `env`, MCP, права проекта) дошли до сеанса. */
  repoLayer: z.boolean(),
  /** Чьё доверие открыло слой репозитория; `unknown` — запись не прочлась (F25). */
  trust: z.enum(['panel', 'cli', 'none', 'unknown']),
  detail: z.string().max(2000).optional(),
});

const repoPin = z.strictObject({
  repoKey: z.string().min(1),
  path: z.string().min(1),
  baseRef: z.string().min(1),
});

export const JOURNAL_DATA_V1 = {
  'task.created': z.strictObject({
    title: text,
    repos: z.array(repoPin),
    build: z.string().min(1),
    scenario: z.strictObject({ id: z.string().min(1), version: nonNeg }),
    profileHash: sha256Hex.nullable(),
    modelCeiling: registryId.nullable(),
    userLayerHash: sha256Hex.nullable(),
    envPin: z.string(),
    requirementsSource: z.string(),
    allowedRoutes: z.array(allowedRouteSchema),
    routesSourceLevel: sourceLevel,
  }),
  'task.transition': transition(TASK_MACHINE, 'taskId'),
  'task.ended': z.strictObject({ outcome: z.enum(['done', 'cancelled', 'failed']) }),
  'requirement.extracted': z.strictObject({ requirementId: uuidv7, text, source: z.string() }),
  'requirement.verdict': z.strictObject({
    requirementId: uuidv7,
    verdict: z.enum(['met', 'unmet', 'waived', 'unknown']),
    evidence: z.array(z.string()),
  }),
  'unit.created': z.strictObject({
    unitId: uuidv7,
    repoKey: z.string().min(1),
    branch: z.string().min(1),
    ownedPaths: z.array(z.string()),
  }),
  'unit.transition': transition(UNIT_MACHINE, 'unitId'),
  'split.proposed': z.strictObject({
    splitId: uuidv7,
    units: z.array(z.strictObject({ name: z.string().min(1), ownedPaths: z.array(z.string()) })),
  }),
  'split.decided': z.strictObject({
    splitId: uuidv7,
    outcome: z.enum(['approved', 'edited', 'refused']),
  }),
  'step.started': z.strictObject({
    stepId: uuidv7,
    unitId: uuidv7,
    stepKind: registryId,
    budgetMs: nonNeg,
  }),
  'step.transition': transition(STEP_MACHINE, 'stepId'),
  /**
   * Принятое заявление модели `step_done` (03 §Model tools) — одна строка-решение: заявление
   * целиком и переход шага `running → checking` (02 §Conductor loop); свёртка читает заявление
   * отсюда. Прежде это были телеметрия `tool.event` (fsync пачкой — заявление, о котором модели
   * уже ответили «принято», могло пропасть при крахе) и отдельный `step.transition`.
   */
  'step.claimed': z.strictObject({ stepId: uuidv7, sessionId: uuidv7, claim: stepDoneSchema }),
  'step.ended': z.strictObject({ stepId: uuidv7, outcome: z.enum(['done', 'failed', 'skipped']) }),
  'session.started': z.strictObject({
    sessionId: uuidv7,
    stepId: uuidv7,
    adapter: registryId,
    cliVersion: z.string(),
    route: routeSchema,
    /** Звенья между CLI и моделью (DLP, шлюз) по порядку и их порты (11 §Hop chain). */
    hops: z.array(z.strictObject({ kind: registryId, port: nonNeg })),
    credentialKind: z.enum(CREDENTIAL_KINDS),
    /** Модель, как её просили, и как её назвал маршрут (`null` — ещё не назвал). */
    modelAsked: registryId,
    modelServed: registryId.nullable(),
    effort: registryId.nullable(),
    hostPid: nonNeg,
    hostStart: processStart,
    cliPid: nonNeg.nullable(),
    cliStart: processStart.nullable(),
    cwd: z.string().min(1),
    /**
     * argv так, как его исполнила ОС (после разрешения обёртки, 03 §Launcher): префикс
     * обёртки + аргументы переходника. Длинный текст уходит файлами — здесь только их пути.
     */
    argv: z.array(z.string()),
    resumeOf: uuidv7.nullable(),
    cacheAgeMs: nonNeg.nullable(),
    /**
     * Слой, с которым сеанс запущен НА ДЕЛЕ (03 §Layer control, F-86): недоверенная копия,
     * запрошенная в `on`, идёт в `observe` — журнал называет понижение, источник доверия и
     * причину. Нет у строк до F-86.
     */
    layer: sessionLayer.optional(),
    /**
     * Аренда маршрута, на которой сеанс запущен: её id у маршрута и ресурсы (`resource.created`
     * владельца `core`). По ней конец задачи снимает аренду и после перезапуска ядра. Нет у строк
     * до того, как дорога стала её писать.
     */
    lease: z.strictObject({ leaseId: z.string().min(1), rids: z.array(uuidv7) }).optional(),
  }),
  'session.transition': transition(SESSION_MACHINE, 'sessionId'),
  'turn.usage': z.strictObject({
    sessionId: uuidv7,
    messageId: z.string().min(1),
    input: nonNeg,
    cacheRead: nonNeg,
    cacheWrite: nonNeg,
    output: nonNeg,
    routeId: registryId,
    model: registryId,
    subagent: z.boolean(),
    parentSessionId: uuidv7.nullable(),
  }),
  'turn.cli-initiated': z.strictObject({
    sessionId: uuidv7,
    cause: z.enum(['notification', 'background-wake', 'late-tail']),
  }),
  'tool.event': z.strictObject({
    sessionId: uuidv7,
    effectClass: registryId,
    target: z.string(),
    ms: nonNeg,
    display: text.optional(),
  }),
  // Запрос проверки (04, `CheckRequestedData` в records.ts): ключ `null` — ключ не прочитан,
  // это прогон, не повтор записи.
  'check.requested': z.strictObject({
    checkRunId: uuidv7,
    checkId: z.string().min(1),
    unit: z.string().min(1),
    key: sha256Hex.nullable(),
    grade: z.enum(['unit', 'narrow', 'retry', 'base'] satisfies RecordGrade[]),
    origin: z.enum(['core', 'session', 'unattended', 'pseudo'] satisfies RecordOrigin[]),
    road: z.enum([
      'capture-preload',
      'capture-wrapper',
      'model-tool',
      'conductor',
      'idle-prerun',
      'pseudo',
    ] satisfies CheckEntryRoad[]),
    stepId: uuidv7.nullable(),
    // Повтор G4 и вывод `pass-flaky` — свои прогоны, связанные с красным его номером (A1r4-F06).
    retryOf: uuidv7.optional(),
  }),
  'check.recorded': z.strictObject({ checkRunId: uuidv7, recordId: z.string().min(1) }),
  'check.transition': transition(CHECK_MACHINE, 'checkRunId'),
  decision: z.strictObject({
    decisionId: uuidv7,
    class: z.enum(DECISION_CLASS_IDS as unknown as [string, ...string[]]),
    inputs: z.array(nonNeg),
    facts: z.array(
      z.strictObject({
        readClass: z.string().min(1),
        kind: z.enum(['value', 'absent', 'unknown']),
      }),
    ),
    numbers: z.record(z.string(), z.number()),
    reasons: z.array(z.string()),
    output: json,
  }),
  'action.started': z.strictObject({
    actionId: uuidv7,
    kind: z.enum(ACTION_KINDS),
    target: z.string().min(1),
    idempotencyHint: z.string(),
  }),
  'action.done': z.strictObject({ actionId: uuidv7, result: json }),
  'action.failed': z.strictObject({
    actionId: uuidv7,
    code: z.string().min(1),
    detail: z.string(),
  }),
  'human.asked': z.strictObject({
    askId: uuidv7,
    point: int.min(1).max(10),
    question: text,
    options: z.array(z.string()),
    defaultAction: z.string().nullable(),
  }),
  'human.answered': z.strictObject({ askId: uuidv7, answer: text, channel: z.string().min(1) }),
  'ask.transition': transition(ASK_MACHINE, 'askId'),
  'command.received': z.strictObject({
    kind: z.string().min(1),
    target: z.strictObject({ taskId: uuidv7 }),
    expectSeq: nonNeg.nullable(),
    fields: json,
    proof: z.strictObject({
      token: z.enum(['none', 'panel-bearer', 'core', 'session']),
      nonce: z.enum(['absent', 'valid', 'invalid']),
      peer: z.enum(['clear', 'session-descendant', 'unknown', 'remote', 'untrusted-forward']),
      signature: z.enum(['absent', 'valid', 'invalid']),
    }),
  }),
  'command.applied': z.strictObject({ outcome: json }),
  'command.rejected': z.strictObject({ code: z.string().min(1), reason: z.string() }),
  'resource.created': z.strictObject({
    rid: uuidv7,
    kind: z.enum(RESOURCE_KINDS),
    owner: z.enum(['core', 'session']),
    release: z.union([
      z.enum(['step-end', 'unit-end', 'task-end']),
      z.strictObject({ keep: z.string().min(1) }),
    ]),
    ref: z.string().min(1),
  }),
  'resource.released': z.strictObject({ rid: uuidv7 }),
  'resource.verified': z.strictObject({ rid: uuidv7, fact: z.string() }),
  'resource.leak': z.strictObject({ rid: uuidv7, reason: z.string() }),
  'copy.integrity': z.strictObject({
    unitId: uuidv7,
    findings: z.array(z.string()),
    repaired: z.array(z.string()),
  }),
  'copy.changed-externally': z.strictObject({ unitId: uuidv7, files: z.array(z.string()) }),
  'publish.transition': transition(PUBLISH_MACHINE, 'unitId'),
  'forge.event': z.strictObject({
    forgeEventId: z.string().min(1),
    type: z.string().min(1),
    target: z.string(),
  }),
  signal: z.strictObject({
    signal: z.string().min(1),
    severity: z.enum(['info', 'warn', 'stop']),
    subject: z.string(),
    detail: z.string(),
  }),
  'budget.state': z.strictObject({
    scope: z.string().min(1),
    spent: nonNeg,
    limit: nonNeg.nullable(),
  }),
  'window.state': z.strictObject({
    routeId: registryId,
    limitKind: z.enum(LIMIT_KINDS),
    verdict: z.enum(['open', 'warn', 'refused']),
    resetAt: nonNeg.nullable(),
  }),
  'clock.jump': z.strictObject({
    wallDeltaMs: int,
    monoDeltaMs: int,
    suspendedMs: nonNeg,
    wallShiftMs: int,
  }),
  'lease.acquired': z.strictObject({
    leaseId: uuidv7,
    build: z.string().min(1),
    pid: nonNeg,
    pidStart: processStart,
    takeoverOf: uuidv7.nullable(),
  }),
  'lease.released': z.strictObject({ leaseId: uuidv7 }),
  'layer.changed': z.strictObject({ userLayerHash: sha256Hex }),
  error: z.strictObject({ code: z.string().min(1), detail: z.string() }),
  'journal.repaired': z.strictObject({ bytes: nonNeg }),
  'journal.migrated': z.strictObject({ fromV: nonNeg, toV: nonNeg }),
} as const;

export type JournalKind = keyof typeof JOURNAL_DATA_V1;
export type JournalDataV1 = { [K in JournalKind]: z.infer<(typeof JOURNAL_DATA_V1)[K]> };
