/**
 * Проверки ядра (этап 3): общие типы зон — запись, ключ, решение, композиция, очередь, профиль,
 * захват, сервисы, мутанты. Только типы; схема zod — у зоны, что владеет проводом или файлом
 * (strict, P45), рядом в своём модуле. Правка зоны — добавление в свой раздел, без переделки чужих.
 * Ссылки: `NN:L` — `.agent/core-spec/NN-*.agent.md` строка L; `D§x` — раздел
 * `.agent/tmp/check-authority-design.agent.md`; `code:` — файл:строка на 29.10.2026.
 * Идентификаторы — UUIDv7, выданные ядром до запуска (01:91, P49), если не сказано иное.
 */
import type { Fact } from './facts.ts';
// `RecordVerdict` ядра (`conductor/model-tools/model-tools.types.ts:17`) — синоним `VerdictName` ниже:
// контракты никогда не импортируют apps/*.

type Uuidv7 = string;
type Sha256Hex = string;
export type RepoPath = string; // прямые слэши, внутри репозитория, без `..` (архив черновиков contracts/check-core.ts repoPath)

// ── запись проверки (реестр) ─────────────────────────────────────────────────────────────────────

/** 04:9, D§3.2 — класс `contract` добавлен в 04:130; `migration` — в 04:128. */
export type CheckClass =
  'static' | 'test-runner' | 'build' | 'live' | 'report-writing' | 'contract' | 'migration';

/** 04:37, D§3.2 — `stop` оставлен только для адаптера старого хука (04:12). */
export type RequiredAt = 'stop' | 'publish' | 'deliver';

/**
 * 06:4 — каждое разрешённое значение несёт уровень источника; файл репо = уровень 4, только сужает
 * (04:9, 06:5-7).
 */
export type SourceLevel =
  'platform' | 'live-user' | 'scenario' | 'project-file' | 'user-layer' | 'detected';

/** 04:50, D§3.2 — одна запись реестра. */
export interface CheckEntry {
  id: string; // стабильный; для незарегистрированных захваченных запусков — `captured:<sha8 нормализованного argv>` (04:51)
  class: CheckClass;
  /**
   * Шаблон argv; плейсхолдеры `{units}` `{base}` `{files}` `{tests}` (D§3.2). Не строка для shell
   * (P25).
   */
  argv: string[];
  cwd: RepoPath; // '' = корень репо
  unit: 'package' | 'project' | 'file-set';
  requiredAt: RequiredAt[];
  baseDependent: boolean; // D§3.3 последний пункт, D§3.7 (не перезапускается)
  /** как гнать только упавшие тесты, по раннеру (D§3.2 `filters`, D§3.7) — нет = не сужается */
  filter?: {
    kind:
      'vitest' | 'jest' | 'pytest' | 'go' | 'playwright' | 'gradle' | 'maven' | 'dotnet' | 'cargo';
    argv: string[];
    /**
     * `unit` — раннер идёт в каталоге единицы, куда его уводит селектор менеджера (`pnpm --filter`
     * члена воркспейса): `{files}` (от корня репо) переводятся от каталога единицы, а не от `cwd`.
     */
    filesFrom?: 'unit';
  };
  inputs: string[]; // globs вне git: `.env*`, lock-файлы (D§3.2)
  envAllow: string[]; // имена env в ключе (D§3.3)
  tools: string[]; // имена инструментов, чья разрешённая версия входит в ключ (D§3.3)
  artifacts: RepoPath[];
  needs: ServiceNeed[]; // 04:124 — сервисы стартуют до первой проверки, которой они нужны
  stand?: { health: string; perUnit: boolean }; // 04:75-77
  source: SourceLevel;
}

/** 04:46-49, D§3.2 — единицы и их замыкания. */
export interface CheckRegistry {
  units: Record<string, { paths: RepoPath[]; consumes: string[] }>; // замыкание = paths + потребители (D§3.2)
  machinery: RepoPath[]; // скрипты и конфиги гейта → в ключе каждой единицы (D§3.3)
  checks: CheckEntry[];
  /** 06:6-7 — расширяющие значения из `.agentdeck/checks.json` отклонены и названы */
  rejected: { path: string; field: string; why: string }[];
}

// ── ключ / отпечаток ──────────────────────────────────────────────────────────────────────────

/**
 * 04:10 (R:S2-32d) — строки отпечатка `(path, mode, blob id)`; одна форма для дерева коммита и
 * рабочего дерева (D§3.3).
 */
export interface TreeRow {
  path: RepoPath;
  mode: '100644' | '100755' | '120000' | '160000';
  blob: string; // id объекта git (репо на sha1 или sha256)
}

/**
 * D§3.3 — все части ключа, хранятся для `diffParts` (почему ключ сдвинулся). Путь копии в него не
 * входит.
 */
export interface KeyParts {
  v: number; // KEY_VERSION; новая версия = только промахи (D§6)
  checkId: string;
  entryHash: Sha256Hex; // defHash(entry)
  unit: string;
  selection: string[]; // суженные тесты/файлы; [] = вся единица
  closure: Sha256Hex; // fp(closure(unit))
  machinery: Sha256Hex;
  base: Sha256Hex | null; // fp(closure @ base) только при baseDependent
  inputs: Sha256Hex; // файлы вне git (D§3.2 inputs)
  tools: Record<string, string>; // имя → разрешённая версия
  env: Record<string, Sha256Hex>; // имя из envAllow → дайджест значения (две POSIX-переменные одного имени без регистра — два через запятую); сами значения не хранятся (04:91), схема хранилища отклоняет иное
}
export type CheckKey = Sha256Hex; // H(canonical(KeyParts))

// ── вердикт ───────────────────────────────────────────────────────────────────────────────────

/**
 * 04:62 (R:S3-11). `aborted` ≠ red (04:63). `selection` — узкий прогон не выбрал ни одного теста
 * (имя теста в привязке устарело): чинится привязка, не окружение.
 */
export type NoVerdictReason = 'aborted' | 'engine' | 'stand' | 'env' | 'selection';
/** 04:62-63 — запрошена, но отсутствует = fail{absent}. */
export type FailReason = 'red' | 'absent';
export type Verdict =
  | { kind: 'pass' }
  | { kind: 'pass-flaky'; retries: RecordId[] } // D§3.7: green-flaky только при измеренных перезапусках с тем же ключом (мутант M5, D§4)
  | { kind: 'fail'; reason: FailReason }
  | { kind: 'no-verdict'; reason: NoVerdictReason };
/** сохраняет форму code:model-tools.types.ts:17 для step_done (P08) */
export type VerdictName = Verdict['kind']; // === RecordVerdict

// ── запись ────────────────────────────────────────────────────────────────────────────────────

/**
 * `<key>.<attempt>` — имя пишется один раз, attempt = первый свободный 0..255 (архив store.cjs).
 */
export type RecordId = string;

/**
 * D§3.4 grade (охват запуска). `base` = запуск на содержимом базы (красное-до 04:68, класс красного
 * 04:78).
 */
export type RecordGrade = 'unit' | 'narrow' | 'retry' | 'base';
/**
 * 04:36 + 03:124 — кто исполнил. Композицию строит только `core` (04:13);
 * `unattended` = из спула (не переигрывается); `session` = захваченный запуск под арендой
 * в процессе сессии (переигрывается на путях захвата, P05); `pseudo` = чужой CLI (04:41).
 */
export type RecordOrigin = 'core' | 'session' | 'unattended' | 'pseudo';

/** D§3.4 + 04:66 — подписана HMAC ключом из домашней папки ядра (04:33). */
export interface CheckRecord {
  v: 3; // архивные черновики были v2 (имена green/red); 04:11 переименовывает вердикты
  id: RecordId;
  key: CheckKey;
  parts: KeyParts;
  checkId: string;
  unit: string;
  grade: RecordGrade;
  origin: RecordOrigin;
  verdict: Verdict;
  exit: number | null;
  ms: number; // без пауз (P43)
  startedAt: number; // epoch ms по часам ядра
  argv: string[]; // argv, который исполнился (03:126)
  failing: { file?: string; name: string }[]; // разобранные упавшие тесты; полный путь vitest "a > b > it" (AGENTS, блок тестов)
  failedCount?: number; // упавших по итогу самого раннера; нет = итог не прочитан. ≠ failing.length → разбор неполон, повтор флаки не идёт (A1r2-F04)
  passing?: { file?: string; name: string }[]; // тесты, названные в логе прошедшими; нет = вывод ни одного не называет → ни один тест не доказан (P50)
  retries: RecordId[];
  artifacts: { path: RepoPath; sha: Sha256Hex }[] | null; // null = не восстановить → не переигрывается (D§3.4)
  envPrepared: boolean; // env, подготовленный ядром (закреплённый профиль + переписанные сервисы) — compose требует true (04:13)
  standEpoch: number | null; // 04:76 — изменился за время запуска → no-verdict(stand)
  taskId: Uuidv7 | null; // id псевдо-задачи для чужих сессий (04:42)
  checkRunId: Uuidv7 | null; // связь с журналом (code: journal-data.ts:238 `check.recorded`)
  log: { bytes: number; truncated: boolean; sha: Sha256Hex }; // `<store>/logs/<id>.log.gz`, голова+хвост свыше 2 МБ (архив store.cjs LOG_CAP)
  /** Итог классов migration/contract; нет — у класса своего итога нет. Входит в sig. */
  classOutcome?:
    | { class: 'migration'; value: MigrationOutcome }
    | { class: 'contract'; value: ContractOutcome[] };
  sig: string; // HMAC по всему, что выше
}

/**
 * API чтения для step_done (code: model-tools.types.ts:21) и conductor. Каждое чтение — Fact (P44).
 */
export interface RecordReader {
  record(id: RecordId): Fact<CheckRecord>;
  byKey(key: CheckKey): Fact<CheckRecord[]>; // по startedAt; плохая подпись / другая версия = пропуск с именем, не зелёное (D§6)
  log(id: RecordId): Fact<string>;
}

// ── решение (verifier/decide — единственный судья `check`, code: decisions.ts:19-23) ─────────────────

/**
 * 03:124 + 07 инструмент модели `check` (code: contracts/core/model-tools.ts:150) + conductor
 * (входы P02).
 */
export type CheckEntryRoad =
  'capture-preload' | 'capture-wrapper' | 'model-tool' | 'conductor' | 'idle-prerun' | 'pseudo';

/**
 * 00:94 входы: ключ, записи, охват, очередь, вердикт окна. Чистая — без IO и текста команды (D§3.5
 * P5).
 */
export interface CheckDecisionInput {
  road: CheckEntryRoad;
  entry: CheckEntry | null; // null = запрошенного id нет в реестре → fail{absent} (04:62)
  unit: string; // запрошенная единица (проверка охвата, fresh в рамках единицы); '' для отсутствующей записи
  selection: string[]; // запрошенные суженные тесты/файлы; [] = вся единица (то же значение, что KeyParts.selection)
  /**
   * Невыполненные условия, уже видные по фактам вызывающего (disk, service-env,
   * registry-unreadable, budget): decide сводит их со своими в ОДИН отказ, называющий все (P03);
   * один disk → defer.
   */
  blockers: Unmet[];
  key: Fact<CheckKey>; // неизвестен → run (04:55 сомнение → run)
  records: Fact<CheckRecord[]>;
  inflight: { checkRunId: Uuidv7; since: number } | null; // single-flight (D§3.8, P68)
  phase: 'mid-task' | 'final'; // 04:56 — весь набор посреди задачи = 0
  changedUnits: string[]; // охват
  window: {
    verdict: 'open' | 'warn' | 'refused';
    basis: 'economy-window';
  }; // decisions.ts:22; книга окон `economy/window` по маршруту шага (этап 5, `checkWindow`)
  fresh: { scope: 'check' | 'unit' | 'key'; ref: string } | null; // разовый fresh-перезапуск (code: commands.ts:43; действует с фазы 5, code: conductor/commands.ts:47)
  quarantined: string[]; // id тестов (04:85)
}

/**
 * D§3.5 виды; `wait` = присоединение к single-flight; каждый отказ перечисляет ВСЕ невыполненные
 * условия + следующее действие (P03).
 */
export type CheckDecision =
  | { kind: 'replay'; recordId: RecordId; header: string }
  | { kind: 'run'; grade: RecordGrade; selection: string[]; reason: string }
  | { kind: 'narrow'; units: string[]; selection: string[]; reason: string }
  | { kind: 'wait'; checkRunId: Uuidv7; deadlineMs: number } // > max(2× выученного, 10 мин) → run + `lock-timeout` (D§6, P05)
  | { kind: 'defer'; until: 'slot' | 'window' | 'disk'; reason: string }
  | { kind: 'refuse'; unmet: Unmet[]; next: string }
  | { kind: 'absent'; recordId: RecordId }; // запись fail{absent} записана (04:62)

/** P03 — один отказ называет каждое невыполненное условие. */
export interface Unmet {
  code:
    | 'red-unchanged'
    | 'budget'
    | 'service-env'
    | 'selection-empty'
    | 'disk'
    | 'registry-unreadable'
    // изменённый код вне замыкания каждой обязательной единицы: реестр прочитан, но код им не покрыт
    | 'unit-unknown'
    | 'coverage-gap'
    | 'record-missing'
    // argv вне реестра там, где гонит ядро (инструмент модели): ядро гонит только проверки реестра
    | 'not-registered'
    // имя теста с ведущим «-»: раннер прочёл бы его как флаг (cargo/gradle/jest кладут имя как есть)
    | 'selection-unsafe';
  subject: string;
  next: string;
}

// ── композиция (verifier/compose, code: decisions.ts:25-28) ───────────────────────────────────

/** D§3.6 + 04:56-59, 04:82-86. */
export interface CompositionInput {
  repo: string; // repoKey
  tree: Sha256Hex; // fp итогового дерева (форма рабочего дерева, D§3.3)
  base: string; // закреплённая база (task.created)
  registry: CheckRegistry;
  changed: RepoPath[];
  records: Record<CheckKey, CheckRecord[]>;
  quarantine: QuarantineEntry[];
  coverage: 'warn' | 'require'; // 04:83 настройка сценария
  /** зона B: выдаёт ядро до решения (P49) — compose остаётся чистой */
  compositionId: Uuidv7;
  /**
   * зона B: ключи, посчитанные вызывающим (A `keyOf`) для каждой пары реестра (check, unit);
   * compose выбирает нужный набор
   */
  keys: CompositionKey[];
  /**
   * зона B: изменённые файлы, покрытые связанным кейсом или тестом, чей запуск их задел (04:82);
   * неизвестно → каждый изменённый исходник — пробел
   */
  covered: Fact<RepoPath[]>;
  /**
   * зона B: проверки, которые сценарий назвал обязательными — их красное на базе всё равно дефект
   * (04:80)
   */
  scenarioRequired: string[];
  /**
   * зона B: когда началась эта композиция (часы ядра) — запись, начатая раньше, считается `reused`
   * (04:57)
   */
  since: number;
}
/** зона B — одна пара реестра на итоговом дереве; `unit` '.' = весь репо (A `closureOf`). */
export interface CompositionKey {
  checkId: string;
  unit: string;
  key: Fact<CheckKey>;
  /** то же замыкание на закреплённой базе (класс красного, 04:78-79); null = не считали */
  baseKey: Fact<CheckKey> | null;
}
export interface CompositionUnit {
  checkId: string;
  unit: string;
  key: CheckKey;
  recordId: RecordId | null;
  verdict: VerdictName | 'missing';
  reused: boolean; // переиграно или запущено (второй compose на том же дереве = 0 запусков, 04:57)
  redClass?: RedClass;
}
export type ComposeDecision =
  | {
      kind: 'ready';
      compositionId: Uuidv7;
      units: CompositionUnit[];
      flaky: string[];
      stale: string[];
      coverageGaps: RepoPath[];
      unquarantine: string[]; // зона B: тесты в карантине, зелёные ≥3 раза подряд — перечислены, решает человек (P75)
    }
  | { kind: 'run'; units: { checkId: string; unit: string; grade: RecordGrade }[] }
  | { kind: 'refuse'; unmet: Unmet[]; next: string };

/**
 * 04:78-81 (R:S2-13). defect → шаг починки; stand/env → действие над средой; stale → только в
 * итоговый отчёт.
 */
export type RedClass = 'defect' | 'stale' | 'stand' | 'flaky' | 'env';

/**
 * 04:60, 04:85-86, D§3.7 — список ядра по репо `<store>/quarantine.json`; зеркалится на кейс блока
 * тестов, если он сопоставлен.
 */
export interface QuarantineEntry {
  test: string; // полный путь теста
  file?: RepoPath;
  checkId: string;
  since: RecordId; // доказанный переход
  greensInRow: number; // ≥3 → в списке на снятие карантина (решает человек, P75)
  caseRef?: { groupId: string; caseId: string };
}

// ── блок тестов (04:65-67, P50) ────────────────────────────────────────────────────────────────
// Отметка прогона ядра — поля `origin: 'core'` + `coreRecordId` самого ProjectTestRunRecord
// (`packages/contracts/src/project-tests.ts`), отдельного типа нет.

/** 04:68-71 (R:S2-14, P94). */
export interface RedBeforeResult {
  test: string;
  base: RecordId; // должна быть fail на своём утверждении (failing[] содержит `test`)
  final: RecordId;
  /**
   * зона B: `red-after` = красное на базе и всё ещё красное на итоге — починка не чинит (гейт
   * остаётся открытым)
   */
  outcome: 'proven' | 'green-on-base' | 'no-verdict-engine' | 'red-after';
}

// ── аренда очереди (verifier/queue, `<core home>/queue/`, 00:59-60, 04:15, D§3.8) ────────────────

/** D§3.8 приоритет; внутри старение; потолок доли на проект (04:118). */
export type QueueClass = 'deliver' | 'fix' | 'review' | 'work' | 'background';
export type LeaseKind = 'check' | 'session' | 'window'; // 00:60; фаза 3 строит `check`
export interface QueueTicket {
  ticketId: Uuidv7;
  kind: LeaseKind;
  class: QueueClass;
  project: string; // repoKey
  taskId: Uuidv7;
  key: CheckKey | null; // id single-flight (P68)
  enqueuedAt: number;
  build: string; // builds/<seq>-<sha> — аренды общие для сборок (00:70-71)
}
export interface QueueLease {
  leaseId: Uuidv7;
  ticket: QueueTicket;
  holder: { pid: number; start: string; bootId: string }; // идентичность P12 (форма старта из таблицы процессов); устаревает после 3 пропущенных ударов (D§3.8)
  heartbeatAt: number;
  slots: number; // слоты в силе на момент выдачи (снижаются при нехватке RAM, 04:116)
}
/** Маркер env потомка: потомки под арендой не захватываются повторно (03:126, D§3.8). */
export type CheckLeaseEnv = 'AGENTDECK_CHECK_LEASE';

/**
 * `<core home>/config.json`, секция `queue` (00:58, пишет только API ядра; перечитывается на каждом
 * опросе, D§3.8).
 */
export interface QueueConfig {
  slots: number; // слоты проверок в силе по всем сборкам (00:70)
  shareCap: number; // 0<x≤1 — доля слотов, которую проект может держать, пока ждёт другой (04:118)
  agingMs: number; // один шаг класса вверх за каждое такое ожидание (D§3.8, старение)
  beatMs: number; // период удара; устаревает после 3 пропущенных (D§3.8)
}

/**
 * conductor/checks `requestCheck` — ЕДИНСТВЕННЫЙ вход (G21, P02): захват, инструмент модели,
 * conductor, прогон на простое.
 */
export interface CheckRequest {
  road: CheckEntryRoad;
  origin: RecordOrigin;
  taskId: Uuidv7; // id псевдо-задачи для чужих сессий (04:42)
  stepId: Uuidv7 | null;
  project: string; // repoKey
  copyDir: string; // где идёт проверка; в ключ не входит (D§3.3)
  class: QueueClass;
  phase: 'mid-task' | 'final';
  /**
   * ровно одно из checkId / argv (схема инструмента модели, code:
   * contracts/core/model-tools.ts:150)
   */
  checkId?: string;
  argv?: string[];
  unit: string;
  /** суженные тесты/файлы; нет или [] = вся единица (то же значение, что KeyParts.selection) */
  selection?: string[];
  changedUnits: string[];
  /** `core` = исполняет раннер ядра; `caller` = сессия гонит под арендой (пути захвата, 03:124) */
  exec: 'core' | 'caller';
  /**
   * exec=caller: значения вызывающего для имён env шима (null = не задано) поверх закрепления ядра
   * в ключе; в журнал не пишутся
   */
  callerEnv?: Record<string, string | null>;
}

/**
 * Ответ `requestCheck`; пути захвата отображают его на CaptureAnswer (D), инструмент модели — на
 * свой ответ.
 */
export type CheckAnswer =
  | {
      kind: 'replay';
      recordId: RecordId;
      verdict: VerdictName;
      exit: number | null;
      header: string;
    }
  | {
      kind: 'ran';
      recordId: RecordId | null; // null = не записано: хранилище отказало или ключ не прочитан (названо в `note`); вердикт без записи — не зелёный для модели
      checkRunId: Uuidv7;
      verdict: Verdict;
      exit: number | null;
      failing: CheckRecord['failing'];
      note?: string;
    }
  | { kind: 'leased'; leaseId: Uuidv7; checkRunId: Uuidv7; argv: string[]; deadlineMs: number } // exec=caller
  | { kind: 'running'; checkRunId: Uuidv7; since: number } // бюджет ответа исчерпан; повторный вопрос → присоединение (P68)
  | { kind: 'defer'; until: 'slot' | 'window' | 'disk'; reason: string }
  | { kind: 'refuse'; unmet: Unmet[]; next: string }
  | { kind: 'narrow'; units: string[]; reason: string } // посреди задачи: единица вне изменённого охвата (04:56)
  | { kind: 'absent'; recordId: RecordId };

// ── профиль (`<core home>/profiles/<repoKey-hash>.json`, 00:59, 04:45-52, 04:88-103) ──────────

export type Stack = 'js-ts' | 'go' | 'python' | 'jvm' | 'dotnet' | 'rust' | 'generic'; // 04:122-123
export interface Profile {
  v: 1;
  repoKey: string;
  inputsFp: Sha256Hex; // отпечаток входов детекта; изменился → пере-детект, действует со следующего шага (04:102-103)
  stacks: {
    stack: Stack;
    root: RepoPath;
    workspace?: 'pnpm' | 'yarn' | 'npm' | 'bun' | 'turbo' | 'nx';
    named?: string;
  }[];
  packageManager: { name: string; version: string } | null;
  runtimes: Record<string, { version: string; from: RepoPath }>; // .nvmrc, toolchain из go.mod, .python-version… (04:89-90)
  pathEntries: string[];
  envNames: string[]; // из образцов; значения не хранятся (04:91)
  serviceVars: ServiceVar[];
  serviceRecipes: ServiceRecipe[];
  registry: CheckRegistry; // найденное + `.agentdeck/checks.json` (только сужает) + правки пользователя
  ciChecks: string[]; // проверки, которые гоняет CI = набор для publish (04:48)
  gitHooks: string[]; // запускаются на собственном commit/push ядра (04:133)
  userEdits: Record<string, unknown>;
  detectedAt: number;
  /**
   * Что детект не охватил (неразобранный CI, обрезанный обход, не разбитые единицы) — называется,
   * молча не пропускается (04:123).
   */
  notes: { subject: string; why: string }[];
}

/** 04:92-96 — классифицируются по имени и схеме URL; значения в журнал не попадают. */
export interface ServiceVar {
  name: string;
  scheme: 'postgres' | 'mysql' | 'mongodb' | 'redis' | 'amqp' | 'kafka' | 'other';
  hostKind: 'ephemeral' | 'local-non-ephemeral' | 'remote'; // не-ephemeral → не зеркалится, называется на единице; использование = пункт 3 человека
  source: 'name' | 'scheme';
}

// Итог путей предполётной проверки (04:105-112) — форма у её владельца,
// `apps/core/src/conductor/preflight/preflight.types.ts` (A1r4-F08: копия здесь не читалась).

// ── захват (03:112-126, 04:35-43) ─────────────────────────────────────────────────────────────

/** POST /v1/session/capture — токен сессии (сессия ядра) или токен захвата (чужой CLI, 04:41). */
export interface CaptureRequest {
  /** Обёртка контейнеров ядро не спрашивает (её итог — ресурсы задачи), своей дороги у неё нет. */
  road: 'node-preload' | 'path-wrapper';
  argv: string[]; // argv, который исполняется (03:126)
  cwd: string;
  envDigest: Sha256Hex; // только по именам, значимым для envAllow; 03:124
  /**
   * значения тех же имён (null = не задано): env ключа запуска вызывающего = закрепление ядра
   * поверх; держатся в памяти, не хранятся (04:91)
   */
  env: Record<string, string | null>;
  pid: number;
  pidStart: number;
  /** только чужой CLI: идентичность ближайшего предка-CLI → псевдо-задача (04:42, пробел G5) */
  ancestor?: { pid: number; start: number; image: string };
}
export type CaptureAnswer =
  | { kind: 'pass-through' } // не проверка (03:125)
  | { kind: 'replay'; recordId: RecordId; exit: number; logPath: string; header: string }
  | { kind: 'run'; leaseId: Uuidv7; checkRunId: Uuidv7; resultUrl: string } // env потомка получает CHECK_LEASE_ENV
  | { kind: 'narrow'; argv: string[]; leaseId: Uuidv7; checkRunId: Uuidv7; resultUrl: string }
  | { kind: 'refuse'; unmet: Unmet[]; next: string; exit: number };
/** POST /v1/session/capture/result */
export interface CaptureResult {
  leaseId: Uuidv7;
  checkRunId: Uuidv7;
  exit: number | null;
  signal: string | null;
  ms: number;
  log: string; // обрезан до головы+хвоста (2 МБ)
  truncated?: boolean; // обёртка срезала вывод; нет — прежняя сборка обёртки
}

/**
 * 04:36 — пишет шим, когда ядро недоступно; принимается как origin `unattended`, не переигрывается
 * и не компонуется.
 */
export interface SpoolRecord {
  v: 1;
  spoolId: string; // `<pidStart>-<pid>-<seq>` — шим не достаёт до выдающего id
  at: number;
  road: CaptureRequest['road'];
  argv: string[];
  cwd: string;
  /**
   * id дерева рабочей копии папки прогона В МИГ записи (тот же, что читает ключ: временный индекс,
   * `add -A`, `write-tree`); `null` — не прочитано. Забор ключует только тем же деревом (B2-F01).
   */
  tree: string | null;
  envDigest: Sha256Hex;
  /** имена, чьи значения вошли в `envDigest` (значения не пишутся); забор сверяет хеш с пином */
  envNames: string[];
  exit: number | null;
  ms: number;
  log: string;
  /** лог обрезан прокладкой (голова + хвост, середина выпала) */
  truncated: boolean;
  token: 'session' | 'capture'; // какой токен держал шим (значение не пишется)
}

// ── сервисы / стенд / ресурсы (04:75-77, 04:121-134) ───────────────────────────────────────

export interface ServiceNeed {
  service: string; // имя рецепта
}
/** 04:124 — compose-файлы, testcontainers, рецепты профиля. */
export interface ServiceRecipe {
  name: string;
  source: 'compose' | 'testcontainers' | 'recipe';
  image: string;
  ports: number[];
  env: Record<string, string>;
  scheme?: ServiceVar['scheme'];
}
/**
 * 04:124-127 — метка `agentdeck.task=<id>` + `claude.ephemeral` (code:
 * platform/resource-scan.ts:235).
 */
export interface ServiceResource {
  rid: Uuidv7; // RESOURCE_KINDS 'container' | 'volume' | 'stand' (code: journal-data.ts:89)
  kind: 'container' | 'volume' | 'stand';
  taskId: Uuidv7;
  engine: 'docker' | 'podman' | 'socket';
  engineId: string; // id контейнера / имя тома / pid+start стенда
  recipe: string;
  endpoint?: { host: '127.0.0.1'; port: number; scheme: ServiceVar['scheme'] };
  cache: boolean; // именованные тома только под кэши — остаются, называются при уборке (04:100-101, 04:126)
  createdAt: number;
}
export interface ServiceEndpoint {
  recipe: string;
  url: string; // переписанное значение для env копии (04:93)
}

/** 04:126-127, P58 — нет движка → сервисные проверки no-verdict(env), не зелёное. */
export interface EngineInfo {
  kind: 'docker' | 'podman' | 'colima' | 'orbstack' | 'docker-compatible';
  socket: string;
  composeV2: boolean;
  composeV1: boolean;
  /**
   * Зона F: CLI, которым ядро говорит с движком; `DOCKER_HOST` для него — `socket`, когда
   * `viaSocket`.
   */
  cli: 'docker' | 'podman';
  /**
   * Движок найден не по контексту CLI, а по известному сокету (Podman/Colima/OrbStack без
   * контекста, 09:30).
   */
  viaSocket: boolean;
  serverVersion: string;
  serverOs: string;
}

/** 04:128-129 — итог класса migration. */
export interface MigrationFinding {
  file: RepoPath;
  statement: string; // фрагмент разрушающего выражения
  kind:
    'drop' | 'truncate' | 'delete-without-where' | 'update-without-where' | 'alter-type' | 'other';
}

/** Зона F — итог класса `migration` (04:128-129): up (и down) на одноразовом контейнере БД. */
export interface MigrationOutcome {
  applied: RepoPath[];
  /** down есть у инструмента — схема после down сверена со схемой до up. */
  down: 'reverted' | 'differs' | 'not-supported';
  /** Строки схемы, появившиеся / ушедшие после up (`pg_dump --schema-only`, нормализовано). */
  schemaDiff: { added: string[]; removed: string[] };
  findings: MigrationFinding[];
  /** Первый упавший файл — красный; `null` — всё применилось. */
  failed: { file: RepoPath; tail: string } | null;
}

/** Зона F — итог класса `contract` (04:130-131): разница схемы и сгенерированных типов. */
export interface ContractChange {
  kind: 'removed' | 'added' | 'changed';
  /** OpenAPI: `paths./x.get.responses.200…`; proto: `message.Field`; GraphQL: `Type.field`. */
  at: string;
  breaking: boolean;
  detail: string;
}
export interface ContractOutcome {
  format: 'openapi' | 'proto' | 'graphql';
  file: RepoPath;
  changes: ContractChange[];
  /**
   * Пересобранные типы клиента не совпали с закоммиченными — список файлов; `null` — генератора
   * нет.
   */
  generatedDrift: RepoPath[] | null;
}

/** Зона F — шаг-конец, защищённые корни (06:105-107, G19): что изменилось вне копии. */
export interface ProtectedRootFinding {
  root: 'main-checkout' | 'sibling-copy' | 'config-dir';
  path: string;
  change: 'status' | 'head' | 'mtime' | 'added' | 'removed';
}

// ── мутации (verifier/mutate, 04:72-74, 08:4-5) ────────────────────────────────────────────────

/**
 * Тот же формат, что у mustfail и `tools/core-linux.mjs --mutants` (code:
 * tools/core-linux-mutants.mjs:7).
 */
export interface MutantPlanRow {
  file: string;
  find: string; // должен встречаться ровно один раз
  replace: string;
  test: string; // имя для vitest -t
  spec: string; // файл теста
}
export type MutantOutcome = 'killed' | 'survived' | 'not-applied' | 'baseline-red';

// ── дополнения журнала (code: journal-data.ts:238-239) ─────────────────────────────────────────

/**
 * Новое событие: свёртке нужна идентичность запуска проверки, чтобы возобновить/прервать его
 * (reduce.ts:190 сворачивает только состояние).
 */
export interface CheckRequestedData {
  checkRunId: Uuidv7;
  checkId: string;
  unit: string;
  key: CheckKey | null;
  grade: RecordGrade;
  origin: RecordOrigin;
  road: CheckEntryRoad;
  stepId: Uuidv7 | null;
  /** повтор G4 и вывод `pass-flaky` — свои прогоны; здесь номер красного, к которому они относятся (A1r4-F06) */
  retryOf?: Uuidv7;
}

// ── классы чтения — строки реестра apps/core/src/lib/facts/read-classes.ts, привязаны там типом
//    `Phase3ReadClassesBound` (расхождение — ошибка сборки); onUnknown по 04:55 «сомнение → run»
//    там, где есть что гнать; нет источника команды или вердикта — refuse (01:104);
//    тест сбоя P44 по каждому классу — у зоны, которая читает ──

export type Phase3ReadClasses = {
  'check.records': { timeoutMs: 5_000; onUnknown: 'run' }; // A
  'check.registry': { timeoutMs: 10_000; onUnknown: 'refuse' }; // E; реестр — источник команды: неизвестный → отказ `registry-unreadable`, ни прогона, ни пропуска (fix-w2R-X01)
  'git.tree': { timeoutMs: 30_000; onUnknown: 'run' }; // A
  'profile.read': { timeoutMs: 10_000; onUnknown: 'run' }; // E
  'tests.cases': { timeoutMs: 5_000; onUnknown: 'run' }; // B; без сопоставления → запись остаётся записью (P50)
  'engine.info': { timeoutMs: 10_000; onUnknown: 'refuse' }; // F → no-verdict(env) (P58)
  'machine.disk': { timeoutMs: 5_000; onUnknown: 'run' }; // E
  'repo.access': { timeoutMs: 5_000; onUnknown: 'refuse' }; // E; macOS TCC → unknown(tcc) (P106)
  'stand.health': { timeoutMs: 5_000; onUnknown: 'refuse' }; // F → no-verdict(stand)
  'capture.spool': { timeoutMs: 5_000; onUnknown: 'retry-until' }; // D
};
