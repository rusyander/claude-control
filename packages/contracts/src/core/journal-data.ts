import { z } from 'zod';
import { registryId, sha256Hex, uuidv7 } from './ids.ts';
import { AGENT_END_HOWS, BG_END_HOWS, BG_KINDS, ownerChainSchema } from './agents.ts';
import { DECISION_CLASS_IDS } from './decisions.ts';
import { intakeCardSchema } from './intake.ts';
import { LEAD_PROFILES, LEAD_ROLES, TASK_CLASSES } from './lead.ts';
import { CI_CLASSES, FORGE_KINDS } from './forge.ts';
import { COMMIT_SHAPES } from './publish.ts';
import { stepDoneSchema } from './model-tools.ts';
import type { CheckEntryRoad, RecordGrade, RecordOrigin } from './records.ts';
import { ROUTE_KINDS, allowedRouteSchema, routeSchema } from './route-schema.ts';
import { overlayEntrySchema, scenarioRefSchema, stepDefId } from './scenario.ts';
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
import { HOOK_OBSERVATIONS_MAX, hookObservationSchema } from './user-layer.ts';
import { GRANT_OPS } from './grant-ops.ts';
import { sessionCarryShape } from './session-carry.ts';

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

// Маршрут модели — лист `route-schema.ts` (его читает и сценарий); здесь реэкспорт для прежних импортов.
export { ROUTE_KINDS, routeSchema, allowedRouteSchema };

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
/**
 * Вердикт окна (смысл каждого — `economy.ts` `WindowDecision`). Список здесь, рядом с видами
 * предела: журнал пишет его в `window.state`, а `economy.ts` берёт отсюда — без круга импортов.
 */
export const WINDOW_VERDICTS = ['open', 'warn', 'refused', 'held', 'exhausted', 'offline'] as const;

/**
 * Действие сигнала наблюдателя для дирижёра (06:132): показать, подсказать модели, снять шаг,
 * пауза в безопасной точке. Каталог сигналов живёт в ядре (`observer/catalog.ts`), здесь — только слова.
 */
export const SIGNAL_ACTIONS = ['show', 'hint', 'stop-step', 'pause-at-safe-point'] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];

/** Вердикт пробы жизни: процесс жив, умер, или ОС не дала ответа (тогда ничего не снимается). */
export const SESSION_PROBE_VERDICTS = ['alive', 'dead', 'unknown'] as const;

/** Уровень, давший набор маршрутов (06 §Precedence: 0 — встроенное … 5 — команда человека). */
const sourceLevel = z.number().int().min(0).max(5);

export const ACTION_KINDS = [
  'push',
  'mr-create',
  'mr-update',
  'thread-reply',
  /** Отдельная заметка в MR (не ответ в нить): итог ревью по ссылке, этап 10 F8. */
  'mr-comment',
  'tracker-write',
  'container-start',
  'container-remove',
  'process-start',
  'copy-create',
  'copy-remove',
  'ref-delete',
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

/** Вердикт требования (02:48, G2): `unknown` — шаг закрыт выводом, требования не судимы. */
export const REQUIREMENT_VERDICTS = ['covered', 'waived', 'n/a', 'open', 'unknown'] as const;
export type RequirementVerdict = (typeof REQUIREMENT_VERDICTS)[number];
/** Откуда требование: из запроса, тикета, найдено ревью, добавлено человеком (`edit-requirements`). */
export const REQUIREMENT_SOURCES = ['request', 'ticket', 'review', 'human'] as const;
/**
 * Источник вопроса человеку (G15): одна функция подъёма на всех. `reconcile` — сверка outbox не
 * узнала исход действия (точка 4): этот вопрос задаёт ядро при загрузке, а не шаг.
 */
export const HUMAN_ASK_SOURCES = [
  'ask_human',
  'blocker',
  'permit',
  'round-cap',
  'budget',
  'scenario-step',
  'launch',
  'reconcile',
  /** Этап 11 (P133): карточка приёма — развилки и подтверждение понятого до запуска. */
  'intake',
] as const;
export type HumanAskSource = (typeof HUMAN_ASK_SOURCES)[number];
export const LAUNCH_POLICIES = ['confirm', 'auto'] as const;
export const STEP_END_BASES = ['claimed', 'derived', 'core', 'not-implemented', 'human'] as const;
export const OVERRIDE_SCOPES = ['task', 'unit', 'step'] as const;
export const COMMAND_TIMINGS = ['safe-point', 'now'] as const;
export { GRANT_OPS };
/**
 * Отчёт пишется в конце задачи. `ready-to-publish` писали задачи до публикатора (фаза 6, G8):
 * значение остаётся, чтобы старые журналы читались; новые строки его не пишут.
 */
export const REPORT_POINTS = ['ended', 'ready-to-publish'] as const;

const gitSha = z.string().regex(/^[0-9a-f]{40,64}$/);

/** Имя переменной окружения задачи — форма имени POSIX, без значения. */
export const taskEnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

/**
 * Настройки сеанса чата от вызывающего (этап 10, F6) — то, что прежний исполнитель панели делал
 * сам, а ядро без них потеряло бы:
 * - `env` — ИМЕНА переменных пина задачи. Значения приходят телом оценки и живут только в памяти
 *   ядра (книга окружения задачи): в журнал, `state.json` и логи не пишутся никогда, перезапуск
 *   ядра их теряет — сеанс без них отказан по имени, а не запущен на окружении ядра.
 *   `CLAUDE_CONFIG_DIR` среди них — каталог конфигурации песочницы вместо каталога человека.
 * - `brief: 'none'` — без брифа ядра: песочница проверяет правила и навыки человека, и строка
 *   ядра в системном промпте подмешалась бы к проверяемому.
 * - `sources: 'user'` — CLI грузит только источник человека (дом конфигурации пина): рабочая
 *   папка песочницы лежит под домом человека, и слой проекта с инструкциями предков подхватил бы
 *   его настоящие `CLAUDE.md`. Переходник без этого умения — отказ дороги по имени.
 * - `scope` — границы правки сеанса: правка вне `edit` (маски от корня) и команды с префиксом
 *   argv из `denyCommands` отказываются судьёй права ядра и пишутся в журнал (агент тестов).
 * - дописка, плагины, сужение источников/навыков/MCP/инструментов (G6) — `session-carry.ts`.
 */
export const taskSessionSchema = z.strictObject({
  ...sessionCarryShape,
  env: z.array(taskEnvNameSchema).min(1).max(32).optional(),
  brief: z.enum(['none']).optional(),
  sources: z.enum(['user']).optional(),
  scope: z
    .strictObject({
      edit: z.array(z.string().min(1).max(500)).min(1).max(64),
      denyCommands: z.array(z.array(z.string().min(1).max(100)).min(1).max(4)).max(32),
    })
    .optional(),
});
export type TaskSession = z.infer<typeof taskSessionSchema>;

export const JOURNAL_DATA_V1 = {
  'task.created': z.strictObject({
    title: text,
    repos: z.array(repoPin),
    build: z.string().min(1),
    scenario: scenarioRefSchema,
    /** Профиль на репозиторий, приколотый при создании (F-066, G21): сдвиг — сигнал, не перечтение. */
    profilePins: z.array(z.strictObject({ repoKey: z.string().min(1), inputsFp: sha256Hex })),
    modelCeiling: registryId.nullable(),
    userLayerHash: sha256Hex.nullable(),
    envPin: z.string(),
    requirementsSource: z.string(),
    allowedRoutes: z.array(allowedRouteSchema),
    routesSourceLevel: sourceLevel,
    /** Ключ повтора оценки (G5): повтор того же `cmdId` находит эту задачу; `null` — задача ядра. */
    origin: z.strictObject({ cmdId: uuidv7 }).nullable(),
    launchPolicy: z.enum(LAUNCH_POLICIES),
    /** Ждать ли CI — живое решение человека для ЭТОЙ задачи (R:S1-09), не сценария. */
    ciWait: z.boolean(),
    /**
     * Платный маршрут при отказе подписки (P117, C6): только явное «да» человека этой задаче.
     * Нет поля — `false`: молчание не разрешает платить.
     */
    paidOnRefusal: z.boolean().optional(),
    /** Язык вопросов, которые ядро пишет само (вопрос запуска); нет поля — английский (P32). */
    lang: z.enum(['ru', 'en']).optional(),
    /**
     * Этап 10: работа в основной папке проекта по гранту человека (06:98). Нет поля — копия;
     * грант пишется строкой `grant.given` с тем же `cmdId`, что у оценки.
     */
    placement: z.enum(['copy', 'in-place', 'scratch']).optional(),
    /**
     * Чат на месте в папке без git (s10 G12 p7, паритет с прежним чатом панели): корень разговора.
     * `repos` у такой задачи пуст — закрепить нечего; копии, ветки и MR нет, работа — в самой папке.
     */
    folder: z.string().min(1).max(1000).optional(),
    /**
     * Лёгкая сессия «ask» (этап 10, F2, `placement: 'scratch'`): инструменты и потребитель контура;
     * мост панели — только адрес и разговор. Токен моста в журнал не пишется никогда.
     */
    ask: z
      .strictObject({
        tools: z.enum(['none', 'panel-bridge']),
        consumer: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,39}$/)
          .optional(),
        bridge: z
          .strictObject({
            url: z.string().min(1),
            conversation: z.string().min(1).optional(),
          })
          .optional(),
        /** Картинки первого слова — файлы каталога задачи; содержимого в журнале нет. */
        images: z
          .array(
            z.strictObject({
              name: z.string().min(1).max(200),
              mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
              file: z.string().regex(/^ask-images\/\d{1,2}\.(png|jpg|gif|webp)$/),
              bytes: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(8)
          .optional(),
      })
      .optional(),
    /**
     * Этап 10, F2: разговор CLI, начатый не ядром, который чат продолжает. Просьба, а не факт:
     * первая сессия шага чата продолжает его, только если переходник подтвердил транскрипт для
     * этого корня (`CliAdapter.ownsTranscript`); иначе сессия отказана с кодом `resume_*`.
     */
    resume: z
      .strictObject({
        adapter: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        conversationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      })
      .optional(),
    /** Этап 10, F6: настройки сеанса чата от вызывающего — см. `taskSessionSchema`. */
    session: taskSessionSchema.optional(),
    /**
     * Этап 10, F8: ревью MR по ссылке (`review-link@1`). Личность MR от форжа и база диффа ревью —
     * общий предок целевой ветки и головы MR: ревьюер видит изменения MR, а не всё от начала копии.
     */
    review: z
      .strictObject({
        url: z.string().min(1).max(2000),
        mrIid: z.number().int().positive(),
        forge: z.enum(['gitlab', 'github']),
        sourceBranch: z.string().min(1).max(300),
        targetBranch: z.string().min(1).max(300),
        reviewBase: gitSha,
      })
      .optional(),
    /** Этап 11: пункт группы панели, из которого задача запущена. */
    groupId: z.string().min(1).max(200).optional(),
    /** Этап 11 (P135): дочерняя задача XL — задача-родитель, разделившая работу. */
    parentTaskId: uuidv7.optional(),
    /** Этап 11 (P144): профиль ведения при запуске; класс — когда он решён до создания. */
    lead: z
      .strictObject({
        profile: z.enum(LEAD_PROFILES),
        class: z.enum(TASK_CLASSES).optional(),
      })
      .optional(),
    /**
     * Этап 11: разговор чата, из которого задача запущена. Не `origin`: то имя уже занято ключом
     * повтора оценки (`{cmdId}`); здесь — только связь для «Агентов» и карточек чата.
     */
    launchOrigin: z
      .strictObject({
        kind: z.literal('chat'),
        conversationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      })
      .optional(),
  }),
  'task.transition': transition(TASK_MACHINE, 'taskId'),
  'task.ended': z.strictObject({ outcome: z.enum(['done', 'cancelled', 'failed']) }),
  'requirement.extracted': z.strictObject({
    requirementId: uuidv7,
    /** Только для показа («R3»); модель цитирует id, никогда номер (F26, G3). */
    ordinal: z.number().int().positive(),
    text,
    source: z.enum(REQUIREMENT_SOURCES),
    stepId: uuidv7.nullable(),
  }),
  'requirement.verdict': z.strictObject({
    requirementId: uuidv7,
    verdict: z.enum(REQUIREMENT_VERDICTS),
    evidence: z.array(z.string().min(1)).max(50),
    reason: z.string().max(2000),
    /** Строка решения (или команды человека), по которой вердикт вынесен. */
    decisionSeq: nonNeg,
  }),
  /** Сверка извлечения со источником (P93): без неё ворота `requirements-covered` закрыты. */
  'requirement.reviewed': z.strictObject({
    stepId: uuidv7,
    complete: z.boolean(),
    added: z.array(uuidv7),
  }),
  'unit.created': z.strictObject({
    unitId: uuidv7,
    name: z.string().min(1).max(200),
    repoKey: z.string().min(1),
    branch: z.string().min(1),
    ownedPaths: z.array(z.string()),
    /** Предшественники: ветка от ветки последнего (02:73), иначе от приколотой базы. */
    after: z.array(uuidv7),
    contract: z.boolean(),
    splitId: uuidv7.nullable(),
    /**
     * Этап 11 (P137): роль куска по плану после проверки деления (неполная спецификация механики
     * уже понижена до `implement`). Нет — роль по умолчанию вида шага.
     */
    role: z.enum(LEAD_ROLES).optional(),
  }),
  'unit.transition': transition(UNIT_MACHINE, 'unitId'),
  'split.proposed': z.strictObject({
    splitId: uuidv7,
    stepId: uuidv7.nullable(),
    /** `core` — предложение ядра по счёту разбора (единица на цель ревью), не плана и не человека. */
    by: z.enum(['plan', 'human', 'core']),
    units: z.array(
      z.strictObject({
        name: z.string().min(1).max(200),
        repoKey: z.string().min(1),
        ownedPaths: z.array(z.string()),
        deps: z.array(z.string().min(1).max(200)),
        contract: z.boolean(),
        estimate: z.strictObject({
          minutes: z.number().int().positive().nullable(),
          tokens: z.number().int().positive().nullable(),
        }),
      }),
    ),
  }),
  'split.decided': z.strictObject({
    splitId: uuidv7,
    outcome: z.enum(['accepted', 'approved', 'edited', 'refused']),
    by: z.enum(['core', 'human']),
    decisionSeq: nonNeg,
  }),
  'step.started': z.strictObject({
    stepId: uuidv7,
    unitId: uuidv7,
    stepKind: registryId,
    /** Шаг сценария, который исполняется, и его круг (G14): повторный вход — новый `stepId`. */
    stepDefId,
    round: nonNeg,
    scenario: scenarioRefSchema,
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
  'step.ended': z.strictObject({
    stepId: uuidv7,
    outcome: z.enum(['done', 'failed', 'skipped']),
    /**
     * На чём стоит исход: `derived` — вывод по git и записям без заявления (02:47, требования —
     * `unknown`); `not-implemented` — шаг публикации до фазы 6 (G8).
     */
    basis: z.enum(STEP_END_BASES),
    reason: z.string().max(2000),
  }),
  /** Напоминание модели о `step_done` — одно на конец хода (P16), не больше трёх подряд. */
  'step.reminded': z.strictObject({
    stepId: uuidv7,
    sessionId: uuidv7,
    /** seq строки конца хода, на который отвечает напоминание. */
    turnSeq: nonNeg,
    count: int.min(1).max(3),
  }),
  /** Новая версия сценария записана один раз (G11); идущий шаг меняется только в безопасной точке. */
  'scenario.edited': z.strictObject({
    cmdId: uuidv7,
    from: scenarioRefSchema,
    to: scenarioRefSchema,
    diff: json,
    applyNow: z.boolean(),
  }),
  /** Правки уровней 3–5 поверх сценария (G12): принятые и отвергнутые — с путём и причиной. */
  'scenario.overlay': z.strictObject({
    scenario: scenarioRefSchema,
    applied: z.array(overlayEntrySchema),
    rejected: z.array(overlayEntrySchema),
  }),
  /** Команда set-model / set-cli (G9): обучению стоимости не подаётся никогда. */
  'override.set': z.strictObject({
    cmdId: uuidv7,
    scope: z.enum(OVERRIDE_SCOPES),
    scopeId: uuidv7,
    field: z.enum(['model', 'effort', 'adapter']),
    value: registryId.nullable(),
    timing: z.enum(COMMAND_TIMINGS),
  }),
  /** Сообщение или ответ дошли до сессии на границе хода — ровно один раз (F26). */
  'message.delivered': z.strictObject({
    stepId: uuidv7,
    sessionId: uuidv7,
    /**
     * cmdId сообщения в шаг / ответа, askId позднего ответа, decisionId последней подсказки
     * наблюдателя (`hint`: снимает её и все прежние подсказки этой сессии, F8).
     */
    ref: z.strictObject({
      kind: z.enum(['message', 'answer', 'late-answer', 'hint']),
      id: uuidv7,
    }),
  }),
  'grant.given': z.strictObject({
    cmdId: uuidv7,
    project: z.string().min(1),
    globs: z.array(z.string().min(1)).min(1),
    ops: z.array(z.enum(GRANT_OPS)).min(1),
  }),
  /** Итоговый отчёт (P96): тело — `finalReportSchema` (`report.ts`) артефактом по sha256. */
  'report.final': z.strictObject({
    at: z.enum(REPORT_POINTS),
    report: z.strictObject({ sha256: sha256Hex, bytes: nonNeg }),
  }),
  'session.started': z.strictObject({
    sessionId: uuidv7,
    stepId: uuidv7,
    adapter: registryId,
    cliVersion: z.string(),
    route: routeSchema,
    /** Звенья между CLI и моделью (DLP, шлюз) по порядку и их порты (11 §Hop chain). */
    hops: z.array(z.strictObject({ kind: registryId, port: nonNeg })),
    credentialKind: z.enum(CREDENTIAL_KINDS),
    /**
     * Модель, как её просили (`null` — не просили: модель по умолчанию CLI, `--model` не передан),
     * и как её назвал маршрут (`null` — ещё не назвал).
     */
    modelAsked: registryId.nullable(),
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
    /** Доля `cacheWrite` с часовым сроком жизни кэша (она дороже пятиминутной). */
    cacheWrite1h: nonNeg,
    output: nonNeg,
    routeId: registryId,
    model: registryId,
    subagent: z.boolean(),
    parentSessionId: uuidv7.nullable(),
    /**
     * Строка-остаток: итог хода (`result`) больше суммы сообщений — разница пишется отдельной
     * строкой, чтобы свёртка сходилась с итогом CLI, не удваивая уже записанное.
     */
    remainder: z.boolean(),
    /**
     * Окно контекста модели хода, как его назвала сама сессия (claude: `result.modelUsage.<model>
     * .contextWindow`). Окно маршрута из настроек главнее; это — для маршрутов без него (вход
     * CLI по подписке). Нет — сессия окна не назвала.
     */
    contextWindow: z.number().int().positive().optional(),
    /**
     * Этап 11 (P149): вызов субагента, чей это ход; `null` — главный контекст сессии. Нет поля —
     * строка до этапа 11 или CLI родителя не назвал: расход узла тогда неизвестен, а не родителю.
     */
    parentToolUseId: z.string().min(1).max(256).nullable().optional(),
  }),
  /** Что вводная отдала сеансу (03 §Context): по набору секций следующий ход шлёт только разницу. */
  'brief.sent': z.strictObject({
    sessionId: uuidv7,
    form: z.enum(['brief', 'delta', 'review-pack']),
    sections: z.array(z.strictObject({ id: z.string().min(1), sha256: sha256Hex, bytes: nonNeg })),
  }),
  /** Базовый контекст сеанса без вводной (G9): замер на подставной модели, ключ — весь набор. */
  'context.base': z.strictObject({
    adapter: registryId,
    cliVersion: z.string().min(1),
    stepKind: registryId,
    layerHash: sha256Hex,
    mcpHash: sha256Hex,
    bytes: nonNeg,
    tokens: nonNeg,
  }),
  'turn.cli-initiated': z.strictObject({
    sessionId: uuidv7,
    cause: z.enum(['notification', 'background-wake', 'late-tail']),
  }),
  /**
   * Вызов инструмента сессии (телеметрия, fsync пачкой) — сырьё предикатов расточительства
   * наблюдателя (06 §Observer, этап 8). Только факты вызова, без текста модели (P32): цель,
   * отпечатки команды и файла, диапазон чтения, исход. `null` — CLI факт не отдал, а не «нет».
   */
  'tool.event': z.strictObject({
    sessionId: uuidv7,
    /** id вызова у CLI: по нему отказ, увиденный и хуком, и потоком, считается один раз. */
    toolUseId: z.string().min(1).max(256),
    /** Вызов внутри подагента — у него свой контекст; `null` — главный контекст сессии. */
    parentToolUseId: z.string().min(1).max(256).nullable(),
    tool: z.string().min(1).max(256),
    effectClass: registryId,
    target: z.string(),
    /** sha256 точного argv исполнения; `null` — не исполнение или argv не разобран точно. */
    argvDigest: sha256Hex.nullable(),
    cwd: z.string().nullable(),
    /** Диапазон чтения; `null` — чтение целиком или вызов не чтение. */
    range: z.strictObject({ offset: int.nullable(), limit: int.nullable() }).nullable(),
    /** Отпечаток файла в момент вызова; `null` — не файл или не прочитан. */
    fileFp: z.string().min(1).max(256).nullable(),
    sizeBytes: nonNeg.nullable(),
    isError: z.boolean(),
    exitCode: int.nullable(),
    /** sha256 замаскированного начала текста ошибки (CRLF → LF до хеша). */
    errorDigest: sha256Hex.nullable(),
    ms: nonNeg,
    display: text.optional(),
    /**
     * Отказ самого CLI (`permission_denials` итога хода, вопрос о праве без отвечающего): строка
     * факта отказа рядом со строкой вызова того же `toolUseId`. Предикаты вызовов её не считают —
     * её читает только повтор отказа (F7), сводя с отказом судьи ядра по id.
     */
    denied: z.literal(true).optional(),
  }),
  /**
   * Этап 11 (P146): вызов начат — строка до `tool.event` того же `toolUseId`. Вызов без конца
   * виден в дереве агентов как идущий; телеметрия, пачкой.
   */
  'tool.started': z.strictObject({
    sessionId: uuidv7,
    toolUseId: z.string().min(1).max(256),
    parentToolUseId: z.string().min(1).max(256).nullable(),
    tool: z.string().min(1).max(256),
    target: z.string().max(2000),
  }),
  /**
   * Этап 11 (P146-P148): сессия запустила субагента. Источник — строки задач потока CLI
   * (`task_started`); выдержка вводной замаскирована и обрезана, полного текста в журнале нет.
   */
  'agent.spawned': z.strictObject({
    sessionId: uuidv7,
    toolUseId: z.string().min(1).max(256),
    parentToolUseId: z.string().min(1).max(256).nullable(),
    /** id задачи у самого CLI: по нему приходят `task_updated` / `task_notification`. */
    cliTaskId: z.string().min(1).max(256),
    kind: z.enum(['subagent', 'other']),
    subagentType: z.string().min(1).max(200).nullable(),
    model: z.string().min(1).max(200).nullable(),
    effort: z.string().min(1).max(200).nullable(),
    background: z.boolean(),
    /** Глубина вложенности; `null` — CLI её не назвал. */
    depth: nonNeg.nullable(),
    briefExcerpt: z.string().max(2000).nullable(),
  }),
  'agent.ended': z.strictObject({
    sessionId: uuidv7,
    toolUseId: z.string().min(1).max(256),
    cliTaskId: z.string().min(1).max(256),
    how: z.enum(AGENT_END_HOWS),
    /** Итог CLI (`task_notification.usage`); `null` — не назван, расход узла неизвестен. */
    usage: z.strictObject({ totalTokens: nonNeg, toolUses: nonNeg, durationMs: nonNeg }).nullable(),
    summaryExcerpt: z.string().max(2000).nullable(),
  }),
  /** Этап 11 (P148): фоновая работа (оболочка, монитор, сервер) с полной цепочкой владельца. */
  'bg.started': z.strictObject({
    itemId: z.string().min(1).max(256),
    kind: z.enum(BG_KINDS),
    excerpt: z.string().max(500),
    ownerChain: ownerChainSchema,
    pid: z.number().int().positive().optional(),
    outputFile: z.string().min(1).max(1000).optional(),
    startedAt: nonNeg,
  }),
  'bg.ended': z.strictObject({
    itemId: z.string().min(1).max(256),
    how: z.enum(BG_END_HOWS),
    exitCode: int.optional(),
    endedAt: nonNeg,
    summary: z.string().max(2000).optional(),
  }),
  /**
   * Этап 11 (P133): карточка приёма принята — сама (`auto`, `askId: null`) или человеком по
   * вопросу `askId`. Критерии карточки — уже строки `requirement.extracted` (P134).
   */
  'intake.card': z
    .strictObject({
      card: intakeCardSchema,
      by: z.enum(['auto', 'human']),
      askId: uuidv7.nullable(),
    })
    .refine((d) => (d.by === 'auto') === (d.askId === null), {
      path: ['askId'],
      message: 'auto card has no ask; a human card names its ask',
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
    source: z.enum(HUMAN_ASK_SOURCES),
    /** Тот же ключ у открытого вопроса — второго нет (P130: один раз на ждущий запрос права). */
    dedupe: z.string().max(500).nullable(),
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
  /** Событие форжа; `causedBy` — действие публикатора, его вызвавшее (иначе это чужая публикация). */
  'forge.event': z.strictObject({
    forgeEventId: z.string().min(1),
    type: z.string().min(1),
    target: z.string(),
    source: z.enum(['publisher', 'poller', 'webhook', 'step-end']).optional(),
    mrIid: int.optional(),
    author: z.string().optional(),
    causedBy: uuidv7.optional(),
  }),
  /** Собранное к публикации: форма коммитов и их sha (05 §Commit shape). */
  'publish.composed': z.strictObject({
    unitId: uuidv7,
    compositionId: uuidv7,
    treeFp: z.string().min(1),
    shape: z.enum(COMMIT_SHAPES),
    commits: z.array(gitSha),
  }),
  /** Личность MR — id, который вернул форж публикатору (P31), а не догадка по ветке. */
  'publish.mr': z.strictObject({
    unitId: uuidv7,
    forge: z.enum(FORGE_KINDS),
    mrId: z.string().min(1),
    mrIid: int,
    url: z.string().min(1),
    sourceBranch: z.string().min(1),
    actionId: uuidv7,
  }),
  /** Нити и конфликт, прочитанные ОДИН раз при открытии MR (05 §After publish). */
  'publish.read': z.strictObject({
    unitId: uuidv7,
    mrIid: int,
    threads: z.array(z.strictObject({ id: z.string().min(1), resolved: z.boolean() })),
    conflict: z.boolean(),
    /**
     * Id заметок других учёток в этих нитях на момент чтения: задача ответов, закончившаяся `done`,
     * разобрала их — опрос форжа по ним новой задачи не открывает (05:77).
     */
    notes: z.array(z.string().min(1)).optional(),
  }),
  'publish.ci': z.strictObject({
    unitId: uuidv7,
    pipelineId: z.string().min(1),
    headSha: gitSha,
    class: z.enum(CI_CLASSES),
    jobs: z.array(
      z.strictObject({ id: z.string().min(1), name: z.string(), class: z.enum(CI_CLASSES) }),
    ),
  }),
  /** Что ядро записало в копию при создании — база сверки дрейфа в конце шага. */
  'publish.closure': z.strictObject({
    unitId: uuidv7,
    copyDir: z.string().min(1),
    pushurls: z.record(z.string(), z.string()),
    hooksPath: z.string().min(1),
    hooksDirFp: z.string().min(1),
    commonAliases: z.record(z.string(), z.string()),
  }),
  /** Ссылки remote в конце шага — с ними сравнивается следующий конец шага. */
  'publish.remote-refs': z.strictObject({
    /** Репозиторий задачи: два репозитория с remote `origin` в одной задаче — разные базы. */
    repoKey: z.string().min(1).optional(),
    remote: z.string().min(1),
    refs: z.record(z.string(), gitSha),
  }),
  /** Цикл ожидания упавшего форжа или сети (05:85): ждёт только публикация. */
  'publish.backoff': z.strictObject({
    unitId: uuidv7,
    attempt: int.min(1),
    waitMs: nonNeg,
    cause: z.string(),
  }),
  signal: z.strictObject({
    signal: z.string().min(1),
    severity: z.enum(['info', 'warn', 'stop']),
    subject: z.string(),
    detail: z.string(),
    /**
     * Что дирижёр делает с сигналом (06:132). Поля нет (строки до этапа 8) — действие выводится из
     * серьёзности: `stop` снимает шаг, прочее только показано.
     */
    action: z.enum(SIGNAL_ACTIONS).optional(),
  }),
  /**
   * Проба жизни затихшей сессии (06 §Observer `stall`, 01:55-56): pid + время старта + прирост
   * процессора по дереву процессов. Долговечная, не телеметрия: на ней стоят потеря и показ сессии.
   */
  'session.probe': z.strictObject({
    sessionId: uuidv7,
    verdict: z.enum(SESSION_PROBE_VERDICTS),
    /** Прирост процессора за окно пробы; `null` — ОС его не отдала. */
    cpuDeltaMs: int.nullable(),
    quietMs: nonNeg,
    thresholdMs: nonNeg,
    /** Класс ожидаемого инструмента, по которому взят порог (`none` — инструмента не ждали). */
    toolClass: z.string().min(1).max(64),
    reason: z.string(),
  }),
  'budget.state': z.strictObject({
    scope: z.string().min(1),
    spent: nonNeg,
    limit: nonNeg.nullable(),
  }),
  /**
   * Новый разрешённый набор задачи живой командой человека (`set-route`, уровень 2, P118) — единственная
   * дорога расширить набор `task.created`; расширение названо (`widened`), а не узнаётся по факту.
   */
  'routes.set': z.strictObject({
    cmdId: uuidv7,
    allowedRoutes: z.array(allowedRouteSchema),
    widened: z.array(allowedRouteSchema),
  }),
  'window.state': z.strictObject({
    routeId: registryId,
    limitKind: z.enum(LIMIT_KINDS),
    verdict: z.enum(WINDOW_VERDICTS),
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
  /**
   * Сводка записи хуков человека в режиме `observe` за сессию (P87, G7): хук исполнился, его
   * вердикт снят. Отказ хука, петля и потеря слоя — сигналы (`hook-block`, `hook-loop`,
   * `layer-loss`), своего вида у них нет.
   */
  'layer.observed': z.strictObject({
    sessionId: uuidv7,
    observations: z.array(hookObservationSchema).max(HOOK_OBSERVATIONS_MAX),
  }),
  error: z.strictObject({ code: z.string().min(1), detail: z.string() }),
  'journal.repaired': z.strictObject({ bytes: nonNeg }),
  'journal.migrated': z.strictObject({ fromV: nonNeg, toV: nonNeg }),
} as const;

export type JournalKind = keyof typeof JOURNAL_DATA_V1;
export type JournalDataV1 = { [K in JournalKind]: z.infer<(typeof JOURNAL_DATA_V1)[K]> };
