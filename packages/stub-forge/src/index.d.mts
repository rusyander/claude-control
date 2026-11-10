/** Типы `@agentdeck/stub-forge` (код — `.mjs` без сборки). */

export interface StubUser {
  id: number;
  username: string;
  /** Выдуманное значение доступа учётки; в след идёт только имя учётки. */
  token: string;
}

export interface StubProject {
  id: number;
  /** `group/name` GitLab и `owner/repo` GitHub — одна запись на оба вида. */
  path: string;
  defaultBranch?: string;
}

export type StubScenario =
  | 'review-threads-unseen'
  | 'mr-red-never-settles-green'
  | 'ci-code-red'
  | 'ci-infra-timeout'
  | 'ci-pending'
  | 'mr-conflict';

export type StubFaultKind = 'status' | 'garbage' | 'stall' | 'reset';

export interface StubFault {
  kind: StubFaultKind;
  /** Для `status`: код ответа (500, 502, 401 …). */
  status?: number;
  method?: string;
  /** Путь (без строки запроса); строка — исходник RegExp. */
  path?: RegExp | string;
  /** Сколько раз сработать; нет — всегда. */
  times?: number;
}

export interface StubJobSeed {
  name?: string;
  status?: 'created' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped';
  failureReason?: string | null;
  startedAt?: number | null;
  scriptStarted?: boolean | null;
  /** Заключение GitHub (`timed_out`, `cancelled` …), если отличается от статуса. */
  conclusion?: string | null;
  trace?: string;
}

type ProjectRef = { project?: string | number };

export type StubAct = ProjectRef &
  (
    | {
        type: 'mr-open';
        sourceBranch: string;
        targetBranch: string;
        title: string;
        body?: string;
        draft?: boolean;
        headSha?: string;
        labels?: string[];
        /** Учётки-ревьюеры (имена). */
        reviewers?: string[];
      }
    | { type: 'mr-update'; mrIid: number; title?: string; body?: string; labels?: string[] }
    | { type: 'mr-reviewers'; mrIid: number; reviewers: string[] }
    | { type: 'mr-close'; mrIid: number }
    | {
        type: 'issue-open';
        title: string;
        body?: string;
        labels?: string[];
        /** Учётки-исполнители (имена). */
        assignees?: string[];
        createdAt?: number;
        epic?: StubEpic;
      }
    | {
        type: 'issue-update';
        iid: number;
        title?: string;
        body?: string;
        labels?: string[];
        state?: 'opened' | 'closed';
      }
    | { type: 'issue-link'; iid: number; targetIid: number; targetProject?: string | number }
    | { type: 'note'; mrIid: number; body: string; threadId?: string; resolvable?: boolean }
    | { type: 'resolve'; mrIid: number; threadId: string; resolved?: boolean }
    | { type: 'push'; ref: string; sha?: string }
    | { type: 'branch-delete'; ref: string }
    | { type: 'approval'; mrIid: number }
    | { type: 'merge'; mrIid: number }
    | {
        type: 'pipeline';
        sha: string;
        ref?: string;
        status?: string;
        createdAt?: number;
        jobs?: StubJobSeed[];
      }
    | { type: 'mergeability'; mrIid: number; conflict?: boolean; checking?: boolean }
  );

export interface StubMr {
  id: number;
  iid: number;
  projectId: number;
  title: string;
  body: string;
  draft: boolean;
  state: 'open' | 'closed' | 'merged';
  authorId: number;
  sourceBranch: string;
  targetBranch: string;
  headSha: string | null;
  createdAt: number;
  updatedAt: number;
  conflict: boolean;
  checking: boolean;
  labels: string[];
  reviewerIds: number[];
}

export interface StubEpic {
  id: number;
  iid: number;
  groupId: number;
  title?: string;
}

export interface StubIssue {
  id: number;
  iid: number;
  projectId: number;
  title: string;
  body: string;
  labels: string[];
  assigneeIds: number[];
  authorId: number;
  state: 'opened' | 'closed';
  createdAt: number;
  updatedAt: number;
  epic: StubEpic | null;
}

export interface StubIssueLink {
  id: number;
  source: { projectId: number; iid: number };
  target: { projectId: number; iid: number };
}

export interface StubNote {
  id: number;
  authorId: number;
  body: string;
  createdAt: number;
}

export interface StubDiscussion {
  id: string;
  projectId: number;
  mrIid: number;
  resolvable: boolean;
  resolved: boolean;
  notes: StubNote[];
}

export interface StubJob {
  id: number;
  name: string;
  status: string;
  failureReason: string | null;
  startedAt: number | null;
  scriptStarted: boolean | null;
  conclusion: string | null;
  trace: string;
}

export interface StubPipeline {
  id: number;
  projectId: number;
  sha: string;
  ref: string | null;
  status: string;
  createdAt: number;
  jobs: StubJob[];
}

export type StubEventType =
  'push' | 'branch-delete' | 'mr-open' | 'mr-update' | 'note' | 'approval' | 'merge';

export interface StubEvent {
  id: number;
  projectId: number;
  type: StubEventType;
  authorId: number;
  at: number;
  ref?: string;
  sha?: string;
  mrIid?: number;
  objectId?: string;
}

export interface StubSnapshot {
  users: { id: number; username: string }[];
  projects: StubProject[];
  mrs: StubMr[];
  discussions: StubDiscussion[];
  pipelines: StubPipeline[];
  events: StubEvent[];
  issues: StubIssue[];
  issueLinks: StubIssueLink[];
}

/** Строка следа (и `requests[]`); в файле следа нет `body`. */
export interface StubRequest {
  at: number;
  method: string;
  path: string;
  bodyHash: string | null;
  /** Имя учётки по значению доступа; `unknown` — значение не узнано; `null` — его не было. */
  tokenId: string | null;
  status: number;
  body: unknown;
  /** Путь слияния / одобрения (P63): ответ 404, состояние не тронуто. */
  forbidden?: true;
  fault?: StubFaultKind;
  control?: true;
}

export interface StubForgeOptions {
  /** 0 — свободный порт ОС; 5170–5180 запрещены. */
  port?: number;
  /** Файл следа (JSON-строка на запрос). */
  trace?: string;
  /** Часы заглушки, мс. */
  now?: () => number;
  users?: StubUser[];
  projects?: StubProject[];
  scenario?: StubScenario | StubScenario[];
  /** Голый репозиторий: голова MR и `syncPushes` читают его ветки. */
  repo?: string;
  faults?: StubFault[];
}

export interface StubForge {
  /** `http://127.0.0.1:<port>` — `baseUrl` обоих видов. */
  url: string;
  port: number;
  requests: StubRequest[];
  /** Учётка → значение доступа (выдуманное) для настройки переходника в тесте. */
  tokens: Record<string, string>;
  /** Действие «другого человека» (или публикатора мимо API) с автором `as`. */
  act(as: string, action: StubAct): unknown;
  /** Ветки голого репозитория со снимком: новое — событие `push`, пропавшее — `branch-delete`. */
  syncPushes(as?: string, project?: string | number): StubEvent[];
  state(): StubSnapshot;
  fault(rule: StubFault): void;
  clearFaults(): void;
  stop(): Promise<void>;
}

export const RESERVED_PORTS: Readonly<{ from: number; to: number }>;
export const FORBIDDEN_SEGMENT: RegExp;
export const GRAPHQL_FORBIDDEN: RegExp;
export const SCENARIO_NAMES: readonly StubScenario[];
export const REVIEW_THREAD_BODIES: readonly string[];
export const DEFAULT_USERS: readonly Readonly<StubUser>[];
export const DEFAULT_PROJECT: Readonly<StubProject>;
export function startStubForge(options?: StubForgeOptions): Promise<StubForge>;
export function closedPortUrl(): Promise<string>;
export function mrBodyHash(title: string, body: string): string;
export function sha256(text: string): string;
export function stubAccess(username: string): string;
