/** Типы `@agentdeck/stub-tracker` (код — `.mjs` без сборки). */

export type StubTrackerDeployment = 'cloud' | 'server';

export interface StubTrackerUser {
  name: string;
  email: string;
  displayName?: string;
  /** Выдуманное значение доступа; нет — `stubTrackerToken(name)`. В след идёт только имя. */
  token?: string;
}

export interface StubTrackerProject {
  id: string;
  key: string;
  name: string;
}

export interface StubIssueLinkSeed {
  /** Имя типа связи Jira: `Blocks`, `Relates`, `Duplicate` (иное — слово в нижнем регистре). */
  type: string;
  key: string;
  direction: 'inward' | 'outward';
}

/** Засев / правка задачи; при правке неназванные поля остаются, `updated` двигается. */
export interface StubIssueSeed {
  key: string;
  summary?: string;
  description?: string;
  status?: string;
  statusCategory?: 'new' | 'indeterminate' | 'done';
  type?: string;
  /** Имя учётки; `null` — без исполнителя. */
  assignee?: string | null;
  labels?: string[];
  priority?: string;
  /** Ключ родителя (эпика); `null` — без родителя. */
  parent?: string | null;
  links?: StubIssueLinkSeed[];
  /** Строки поля «Acceptance Criteria». */
  acceptance?: string[];
}

export interface StubComment {
  id: string;
  author: string;
  /** Тело, как его прислали (ADF облака или строка своей установки). */
  body: unknown;
  /** Тело текстом. */
  text: string;
  created: number;
}

export interface StubIssue {
  id: string;
  key: string;
  project: string;
  summary: string;
  description: string;
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done';
  type: string;
  assignee: string | null;
  labels: string[];
  priority: string;
  parent: string | null;
  links: StubIssueLinkSeed[];
  acceptance: string[];
  comments: StubComment[];
  created: number;
  updated: number;
}

export interface StubTrackerSnapshot {
  users: { name: string; email: string; displayName: string }[];
  projects: StubTrackerProject[];
  issues: StubIssue[];
}

export type StubTrackerFaultKind = 'status' | 'garbage' | 'stall' | 'reset';

export interface StubTrackerFault {
  kind: StubTrackerFaultKind;
  /** Для `status`: код ответа (500, 410, 429 …). */
  status?: number;
  /** Для `status`: заголовок `Retry-After` в секундах (429/503 трекера). */
  retryAfter?: number;
  method?: string;
  /** Путь без строки запроса; строка — исходник RegExp. */
  path?: RegExp | string;
  /** Сколько раз сработать; нет — всегда. */
  times?: number;
}

/** Строка следа (и `requests[]`); в файле следа нет `body`. */
export interface StubTrackerRequest {
  at: number;
  method: string;
  path: string;
  /** JQL, как его раскодировал сервер (только у запросов с `jql`). */
  jql?: string;
  bodyHash: string | null;
  /** Схема `Authorization`: `basic`, `bearer`, `other`; `null` — заголовка не было. */
  auth: 'basic' | 'bearer' | 'other' | null;
  /** Имя учётки по значению доступа; `unknown` — не узнано; `null` — его не было. */
  tokenId: string | null;
  status: number;
  body: unknown;
  fault?: StubTrackerFaultKind;
  control?: true;
}

export interface StubTrackerOptions {
  /** 0 — свободный порт ОС; 5170–5180 запрещены. */
  port?: number;
  /** Файл следа (JSON-строка на запрос). */
  trace?: string;
  /** Часы заглушки, мс. */
  now?: () => number;
  /** Диалект сайта; по умолчанию `cloud`. */
  deployment?: StubTrackerDeployment;
  users?: StubTrackerUser[];
  projects?: StubTrackerProject[];
  /** Засев задач; нет — `DEFAULT_ISSUES`. */
  issues?: StubIssueSeed[];
  faults?: StubTrackerFault[];
}

export interface StubTracker {
  /** `http://127.0.0.1:<port>` — `baseUrl` сайта. */
  url: string;
  port: number;
  deployment: StubTrackerDeployment;
  requests: StubTrackerRequest[];
  /** Учётка → значение доступа (выдуманное). */
  tokens: Record<string, string>;
  users: { name: string; email: string; displayName: string }[];
  /** Правка задачи «другим человеком» мимо API; ключ задачи. */
  upsertIssue(seed: StubIssueSeed): string;
  state(): StubTrackerSnapshot;
  fault(rule: StubTrackerFault): void;
  clearFaults(): void;
  stop(): Promise<void>;
}

export class JqlError extends Error {}
export interface ParsedJql {
  clauses: { field: string; op: string; values?: unknown[] }[];
  order: { field: string; desc: boolean }[];
}
export function parseJql(source: string): ParsedJql;

export const RESERVED_PORTS: Readonly<{ from: number; to: number }>;
export const ACCEPTANCE_FIELD_ID: string;
export const ACCEPTANCE_FIELD_NAME: string;
export const DEFAULT_USERS: readonly Readonly<Required<StubTrackerUser>>[];
export const DEFAULT_PROJECTS: readonly Readonly<StubTrackerProject>[];
export const DEFAULT_ISSUES: readonly Readonly<StubIssueSeed>[];
export const WORKFLOW: readonly Readonly<{
  id: string;
  name: string;
  status: string;
  category: 'new' | 'indeterminate' | 'done';
}>[];
export function startStubTracker(options?: StubTrackerOptions): Promise<StubTracker>;
export function stubTrackerToken(name: string): string;
