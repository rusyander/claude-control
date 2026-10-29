/**
 * Типы для `index.mjs` — код пакета остаётся `.mjs` без сборки (его грузит и голый
 * `node`), а тесты ядра и пакета видят API через это объявление.
 */

export type DialectId = 'anthropic-messages' | 'openai-chat' | 'openai-responses';

export declare const DIALECT_IDS: readonly DialectId[];

export declare const RESERVED_PORTS: { readonly from: 5170; readonly to: 5180 };

/** Значение заголовка доступа в следе и в `requests[].headers`. */
export declare const PRESENT: '<present>';

export declare function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]>;

export interface ToolCall {
  name: string;
  args?: unknown;
  /** Свой id вызова; без него — `call_stub_<n>_<i>` / `toolu_stub_<n>_<i>`. */
  id?: string;
}

/** Окно подписки / предел частоты: Anthropic — `anthropic-ratelimit-unified-*`, OpenAI — `x-ratelimit-*`. */
export interface WindowInfo {
  /** Доля использованного, 0..1. */
  utilization?: number;
  /** Сброс, unix-секунды. */
  resetsAt?: number;
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  claim?: 'five_hour' | 'seven_day';
}

export interface StepError {
  /** 402 бюджет, 429 предел (+ `retryAfter`), 451 отказ по политике, 503 недоступен; любой 4xx/5xx. */
  status: number;
  message?: string;
  /** Секунды в заголовок `retry-after`. */
  retryAfter?: number;
  /** Ошибка ПОСЛЕ начала потока (событие ошибки протокола), а не статус HTTP. */
  midStream?: boolean;
  /** Свой тип / код ошибки в теле вместо выведенного из статуса. */
  type?: string;
  code?: string;
}

export interface Step {
  /** Массив — один текстовый блок несколькими дельтами потока (в JSON — склеен). */
  text?: string | string[];
  tool?: ToolCall;
  tools?: ToolCall[];
  /** Свободный инструмент responses (apply_patch у Codex); в других протоколах — ошибка сценария. */
  custom?: { name: string; input: string; id?: string };
  error?: StepError;
  /**
   * Держать ответ до первого байта, мс; `Infinity` — до `release()`/`close()`/ухода
   * клиента (длиннее 2^31−1 мс — тоже честно, отрезками таймера).
   */
  holdMs?: number;
  /** Держать поток после его начала, до содержимого, мс; `Infinity` — как у `holdMs`. */
  stallMs?: number;
  window?: WindowInfo;
  /** Свои заголовки ответа (поверх заголовков окна). */
  headers?: Record<string, string>;
  /**
   * Расход в полях протокола как есть: `input` — `input_tokens` Anthropic (без кеша) /
   * `prompt_tokens` OpenAI (с кешем); `cached` — `cache_read_input_tokens` /
   * `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens`.
   */
  usage?: { input?: number; output?: number; cached?: number };
  /**
   * Поля сверх протокола в итоговом объекте ответа (`timings` у llama-server): JSON —
   * верхний уровень; поток — `message_delta` (Anthropic), последний чанк перед `[DONE]`
   * (chat), объект `response` события `response.completed` (responses).
   */
  extra?: Record<string, unknown>;
}

export interface RequestInfo {
  model: string | undefined;
  stream: boolean;
  includeUsage?: boolean;
  userTexts: string[];
  tools: { name: string; schema?: unknown; custom?: boolean }[];
  hasToolResult: boolean;
}

export interface RequestRecord {
  /** Номер модельного запроса с единицы. */
  n: number;
  at: string;
  method: string;
  path: string;
  /** Заголовки; значения доступа — `PRESENT`. */
  headers: Record<string, string | string[]>;
  dialect: DialectId;
  model: string | undefined;
  stream: boolean;
  userTexts: string[];
  /** Имена инструментов, объявленных в запросе. */
  tools: string[];
  hasToolResult: boolean;
  /** Сырое тело запроса. */
  raw: string;
  body: Record<string, unknown>;
  /** Подпись ответа: текст, `tool:<имя>`, `custom:<имя>`, `error:<статус>`. */
  reply?: string;
  status?: number;
  scriptError?: string;
  /** Клиент оборвал запрос сам во время `holdMs`/`stallMs` (не `close()` заглушки). */
  aborted?: true;
}

export interface StepContext {
  /** Номер модельного запроса с нуля. */
  index: number;
  request: RequestRecord;
  /** Все модельные запросы, включая текущий. */
  requests: readonly RequestRecord[];
  /** Сырые тела всех модельных запросов, включая текущий. */
  bodies: readonly string[];
  dialect: DialectId;
  info: RequestInfo;
}

/** Строка — короткая запись `{ text }`. */
export type StepLike = Step | string;
export type StepResult = StepLike | null | undefined;
export type StepFn = (ctx: StepContext) => StepResult | Promise<StepResult>;

export interface Rule {
  /** Строка — метка в сыром теле; RegExp — по сырому телу; функция — по контексту. */
  when: string | RegExp | ((ctx: StepContext) => boolean);
  step: StepLike | StepFn;
  /** Сколько раз правило срабатывает: целое ≥ 1; по умолчанию без предела. */
  times?: number;
}

/**
 * Сценарий. Шаги-данные (массив, `rule.step`, `fallback`) проверяются при запуске —
 * опечатка в ключе отказывает `startStubModel`; шаг-функция — на запросе (ответ
 * `STUB SCRIPT FAILED` с `requests[].scriptError`).
 */

export type Script =
  StepLike[] | StepFn | { rules?: Rule[]; steps?: StepLike[] | StepFn; fallback?: StepLike };

/** Запрос, как его видит `route`: заголовки — сырые (это код вызывающего, не след). */
export interface RouteRequest {
  method: string;
  /** Путь без строки запроса и без хвостового `/`. */
  path: string;
  /** Строка запроса с `?` или пусто. */
  query: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
  /** Разобранное тело-объект; не JSON, пусто или не объект (`5`, `null`, массив) — `undefined`. */
  body: Record<string, unknown> | undefined;
}

export interface RouteReply {
  /** По умолчанию 200. */
  status?: number;
  /** Строка — как есть (`text/plain`), иначе JSON. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface StubModelOptions {
  /** 0 (по умолчанию) — свободный от ОС; 5170–5180 — отказ. Слушает только 127.0.0.1. */
  port?: number;
  /** Файл следа (JSON-строка на запрос), дописывается; без него — без следа. */
  trace?: string;
  script?: Script;
  /** Ответ `GET …/models`; по умолчанию `['stub-model']`. */
  models?: string[];
  /**
   * Свои пути вызывающего: зовётся на КАЖДЫЙ запрос до путей пакета; ответ — уходит
   * он (след: `kind: 'route'`), `undefined` — запрос идёт дальше (наблюдатель).
   */
  route?: (request: RouteRequest) => RouteReply | undefined | Promise<RouteReply | undefined>;
}

export interface StubModel {
  port: number;
  baseUrl: string;
  requests: RequestRecord[];
  bodies: string[];
  /** Идёт ли сейчас `holdMs`/`stallMs` хоть одного запроса. */
  holding(): boolean;
  /** Досрочно кончить все текущие `holdMs`/`stallMs`: ответы уходят сразу. */
  release(): void;
  /** Закрыть: удержания обрываются, соединения рвутся. */
  close(): Promise<void>;
}

export declare function startStubModel(options?: StubModelOptions): Promise<StubModel>;

export declare const STUB_CAPS: {
  readonly dialects: readonly DialectId[];
  readonly streaming: true;
  readonly nonStreaming: true;
  readonly tools: true;
  readonly customTools: readonly DialectId[];
  readonly errors: readonly number[];
  readonly midStreamErrors: true;
  readonly window: true;
  readonly hold: true;
  readonly stall: true;
  readonly chunkedText: true;
  readonly cachedUsage: true;
  readonly extraFields: true;
  readonly release: true;
  readonly aborted: true;
  readonly routes: true;
  readonly images: false;
  readonly offline: true;
};
