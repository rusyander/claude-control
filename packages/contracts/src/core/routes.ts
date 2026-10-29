import type { Dialect, LoginKind } from '@agentdeck/providers/types';
import type { Fact, UnknownAction } from './facts.ts';
import type { CREDENTIAL_KINDS, LIMIT_KINDS, RESOURCE_KINDS, ROUTE_KINDS } from './journal-data.ts';

/**
 * Шов «переходник × маршрут» (спецификация 11 R:PR-03, R:PR-05; 03 §CLI adapter). Здесь только
 * ТИПЫ и закрытый список кодов отказа: `apps/core/src/adapters/` и `apps/core/src/routes/` оба
 * берут их отсюда и потому не импортируют друг друга (00 §Parts, P108).
 *
 * Имена — непрозрачные строки, сверяемые с реестрами в рантайме: ни id CLI, ни id маршрута, ни
 * имени модели перечислением здесь нет (владелец, 28.10). Вид маршрута — структурный список из
 * пяти строк таблицы 11 §Two axes (`ROUTE_KINDS`), не имена провайдеров.
 *
 * `Dialect` и `LoginKind` — из фактов запуска CLI (`@agentdeck/providers`, спецификация 11 C2):
 * одно объявление на всех, импорт только типов — стирается при запуске strip-types.
 */

export type { Dialect, LoginKind };

export type RouteKind = (typeof ROUTE_KINDS)[number];
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export type LimitKind = (typeof LIMIT_KINDS)[number];
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** `cli-login:<adapter>`, `api-key:<vendor|endpoint>`, `local:own`, `local:user:<host>`, `gateway:<id>`, `stub:<script>`. */
export type RouteId = string;
export type AdapterId = string;
export type ModelId = string;

// ── Возможности маршрута ──────────────────────────────────────────────────────────────

/**
 * Как сеанс доходит до маршрута: собственным входом ОДНОГО CLI (без адреса — 11 §Hop chain:
 * привязка адреса есть у всех маршрутов, кроме `cli-login`) или адресом, привязанным на сеанс.
 */
export type RouteBinding = { via: 'cli-login'; adapter: AdapterId } | { via: 'endpoint' };

export interface RouteCaps {
  /** Диалекты на входе маршрута (11 R:PR-03). Пусто у `cli-login`: провод выбирает сам CLI. */
  dialects: Dialect[];
  tools: boolean;
  images: boolean;
  streaming: boolean;
  /** Тело запроса разбирается DLP-звеном (11 R:PR-02). */
  maskable: boolean;
  /** Работает без интернета (P77 в 11 R:PR-06). */
  offline: boolean;
  binding: RouteBinding;
  /**
   * Пределы, которые CLI обязан знать (окно, сроки, простой — локальный сервер, 11 R:PR-04).
   * Нет канала у переходника → отказ `window_untellable`.
   */
  limitsToTell: boolean;
}

// ── Факты маршрута (01 §Facts, 11 таблица R:PR-03) ────────────────────────────────────

export type RouteFactName =
  'availability' | 'models' | 'limit' | 'price' | 'credential' | 'context';

/** Каждое чтение маршрута объявляет класс чтения и действие на `unknown` (01 §Facts, P111). */
export interface RouteFactDecl {
  fact: RouteFactName;
  /** Имя класса из реестра классов чтения ядра (`route.<fact>`). */
  readClass: string;
  onUnknown: UnknownAction;
}

/** `absent` — маршрута нет (сервер лёг, вход не выполнен); `startable` — `local:own` поднимется сам. */
export interface RouteAvailability {
  state: 'up' | 'startable';
}

export interface RouteModel {
  id: ModelId;
  sizeBytes?: number;
  contextTokens?: number;
  tools?: boolean;
  images?: boolean;
}

export type RouteLimit =
  | { kind: 'window'; source: 'in-band-event' | 'unknown' }
  | { kind: 'rate' }
  | { kind: 'budget'; exhaustedAt?: number }
  | { kind: 'slot'; slots: number }
  | { kind: 'none' };

/** Цена: деньги — только по таблице; подписка — единицы окна, локальная — время карты (11 R:PR-06). */
export type RoutePrice =
  { unit: 'money'; source: string } | { unit: 'window' } | { unit: 'gpu-time' } | { unit: 'none' };

/** Доступ — только НАЛИЧИЕ и вид; значение никогда (11 §Policy, P111). */
export interface RouteCredential {
  kind: CredentialKind;
  present: boolean;
}

export interface RouteFactReaders {
  availability(): Promise<Fact<RouteAvailability>>;
  models(): Promise<Fact<RouteModel[]>>;
  limit(): Promise<Fact<RouteLimit>>;
  price(model: ModelId): Promise<Fact<RoutePrice>>;
  credential(): Promise<Fact<RouteCredential>>;
  context(model: ModelId): Promise<Fact<number>>;
}

// ── Аренда, адрес, ресурсы ────────────────────────────────────────────────────────────

/**
 * Ссылка на доступ: значение разрешает пускатель при запуске (03 §Launcher), в памяти ядра его
 * нет. `hop-injected` — заглушка сеанса, настоящий ключ подставляет звено.
 */
export type KeyRef =
  | { kind: 'panel-store'; name: string }
  | { kind: 'env'; name: string }
  | { kind: 'hop-injected'; tag: string };

export interface RouteEndpoint {
  /**
   * Origin сервера (`http://127.0.0.1:<port>`) без пути: путь диалекта (`/v1` и т. п.)
   * добавляет привязка переходника — так, как его ждёт канал этого CLI.
   */
  baseUrl: string;
  dialect: Dialect;
  keyRef: KeyRef | null;
}

export interface RouteAcquireSpec {
  taskId: string;
  sessionId?: string;
  model: ModelId;
  /** Диалект входа, выбранный совместимостью (`direct` — канал, `via-gateway` — `to`); нет — первый из возможностей. */
  dialect?: Dialect;
  /** Когда освобождать ресурсы аренды (01 §Resources); по умолчанию `task-end`. */
  release?: ResourceRelease;
  /** Ожидание слота и запуск прерываемы (`AbortSignal`; контракты без типов DOM и node). */
  signal?: AbortLike;
}

export interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export type ResourceRelease = 'step-end' | 'unit-end' | 'task-end' | { keep: string };

export interface RouteResource {
  rid: string;
  kind: ResourceKind;
  ref: string;
  release: ResourceRelease;
}

/**
 * Запись решения маршрута для журнала (`decision`, 01 §Facts): какие факты взяты и с каким
 * исходом, числа и причины. Маршрут журнала не знает — пишет дирижёр через `RouteRecorder`.
 */
export interface RouteDecisionRecord {
  class: 'fit' | 'compat' | 'slot-wait' | 'endpoint';
  facts: { readClass: string; kind: 'value' | 'absent' | 'unknown' }[];
  numbers: Record<string, number>;
  reasons: string[];
  output: unknown;
  /**
   * Есть — решение ставит задачу перед человеком (факт `unknown` после срока повторов, 01 §Facts):
   * что именно не доказано и почему. Фаза 2 на этом останавливается (как P130): задача ждёт.
   */
  humanPoint?: { subject: string; reason: string; readClass: string };
}

/**
 * Куда маршрут сообщает о своих действиях. Вызов ДО действия (решение подбора — до загрузки,
 * ресурс — сразу после создания) — порядок в журнале совпадает с порядком в мире.
 */
export interface RouteRecorder {
  decision(record: RouteDecisionRecord): void | Promise<void>;
  created(resource: RouteResource): void | Promise<void>;
  verified(rid: string, fact: string): void | Promise<void>;
  leak(rid: string, reason: string): void | Promise<void>;
}

export interface RouteLease {
  leaseId: string;
  routeId: RouteId;
  model: ModelId;
  /** Ресурсы этой аренды в порядке создания; освобождаются в обратном. */
  resources: RouteResource[];
}

export interface ReleaseOutcome {
  verified: { rid: string; fact: string }[];
  leaks: { rid: string; reason: string }[];
}

export interface Route {
  kind: RouteKind;
  id: RouteId;
  caps: RouteCaps;
  facts: readonly RouteFactDecl[];
  read: RouteFactReaders;
  acquire(spec: RouteAcquireSpec, record: RouteRecorder): Promise<RouteLease>;
  /**
   * Адрес сервера аренды — только доказанно живого (F-73): процесс по личности (pid + старт) жив
   * и порт отвечает пробе здоровья. Иначе `null` и решение класса `endpoint` в журнал через
   * `record`: мёртвый сервер или номер, ушедший чужому процессу на том же порту, адреса не дают.
   * `null` у `cli-login` — адреса нет вовсе, CLI идёт своим входом (решения нет).
   */
  endpoint(lease: RouteLease, record: RouteRecorder): Promise<RouteEndpoint | null>;
  release(lease: RouteLease, record: RouteRecorder): Promise<ReleaseOutcome>;
  /**
   * Чистая остановка ядра: освободить всё, что маршрут держит (свои аренды и вернувшиеся после
   * перезапуска). Есть только у маршрута, чьи процессы переживают крах ядра (заглушка, своя
   * модель); крах этот вызов не делает — серверы остаются для следующего ядра.
   */
  shutdown?(record: RouteRecorder): Promise<ReleaseOutcome>;
}

// ── Возможности переходника, которые читает совместимость (03, 11 R:PR-05) ─────────────

export interface AdapterChannelSummary {
  via: 'env' | 'argv' | 'file';
  dialect: Dialect;
  keyVar?: string;
  /** Настройка человека, при которой CLI не прочтёт наш адрес. */
  bypass?: { setting: string; requires?: string };
  /**
   * Канал пишется на ОДИН сеанс (окружение, argv, свой файл рядом с конфигом). `false` — только
   * правка общего файла человека: для ядра такой канал `unsupported` (11 R:PR-05).
   */
  perSession: boolean;
}

export interface AdapterCaps {
  resume: boolean;
  mcp: boolean;
  strictMcp: boolean;
  permissionTool: boolean;
  denyOverlay: boolean;
  preToolHooks: boolean;
  layerControl: boolean;
  /** `false` = атрибуции нет, ядро ставит каждую отправку в очередь (03). */
  attribution: boolean;
  stream: boolean;
  effort: boolean;
  images: boolean;
  subagents: boolean;
  login: LoginKind;
  /** В порядке предпочтения; пусто — только свой вход CLI. */
  channels: AdapterChannelSummary[];
  /** Событие окна подписки задокументировано (11 R:PR-06); нет — `unknown`, отказ читается в потоке. */
  windowEvent: boolean;
  /** Канал пределов локальной модели; `null` — не сказать (`window_untellable`). */
  limitsChannel: 'env' | 'settings-file' | null;
}

// ── Совместимость (11 R:PR-05) ────────────────────────────────────────────────────────

/** Закрытый список кодов отказа — надмножество сегодняшних причин пропуска (11 R:PR-05). */
export const REFUSAL_CODES = [
  'no_channel',
  'login_only',
  'bypass_setting',
  'dlp_opaque',
  'model_absent',
  'context_too_small',
  'window_untellable',
  'no_tools',
  'credential_absent',
  'route_unavailable',
  'not_allowed',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type FactState = 'value' | 'absent' | 'unknown';

export interface CompatAdapter {
  id: AdapterId;
  caps: Pick<AdapterCaps, 'login' | 'channels' | 'limitsChannel'>;
  /** Прочитанное переходником состояние настроек обхода по имени; нет записи — `unknown`. */
  bypassActive: Record<string, boolean | 'unknown'>;
}

export interface CompatRoute {
  id: RouteId;
  caps: RouteCaps;
  availability: { state: FactState; onUnknown: UnknownAction };
  /** `none` — маршруту доступ не нужен (своя модель, заглушка, вход CLI). */
  credential: FactState | 'none';
}

export interface ModelFacts {
  id: ModelId;
  /** Маршрут отдаёт эту модель: `value` — да, `absent` — нет. */
  served: FactState;
  contextTokens?: number;
  tools?: boolean;
}

export interface AllowedTriple {
  adapter: AdapterId;
  route: RouteId;
  /** `*` — любой хвост; иначе точное совпадение. */
  modelPattern: string;
}

export interface CompatCandidate {
  adapter: CompatAdapter;
  route: CompatRoute;
  model: ModelFacts;
}

export interface CompatPolicy {
  allowed: readonly AllowedTriple[];
  dlp: { required: boolean; parses: readonly Dialect[] };
  /** Пары перевода, которые умеет звено шлюза (из его возможностей, не из имён). */
  translations: readonly { from: Dialect; to: Dialect }[];
  needsTools: boolean;
  minContextTokens?: number;
  /** Кандидаты внутри разрешённого набора: при отказе та же функция назовёт годных. */
  candidates?: readonly CompatCandidate[];
}

export interface CompatAlternative {
  adapter: AdapterId;
  route: RouteId;
  model: ModelId;
  kind: 'direct' | 'via-gateway';
}

export type LoginChannel = { via: 'login' };

export type CompatDecision =
  | { kind: 'direct'; channel: AdapterChannelSummary | LoginChannel }
  | { kind: 'via-gateway'; channel: AdapterChannelSummary; from: Dialect; to: Dialect }
  | {
      kind: 'refused';
      code: RefusalCode;
      /** Только у `bypass_setting`: какая настройка мешает. */
      setting?: string;
      alternatives: CompatAlternative[];
    };

/** Имя из постановки (11 R:PR-05); класс решения в реестре — `CompatDecision` (P01). */
export type CompatResult = CompatDecision;
