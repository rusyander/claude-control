import type { Fact } from './facts.ts';

/**
 * Форж глазами ядра (05 §Push and MR, фаза 6). Публикует только ядро; у сессий нет ни пишущих
 * инструментов форжа, ни дороги пуша. Чужой форж — только пуш и ссылка (`generic`), названо.
 */
export const FORGE_KINDS = ['gitlab', 'github', 'generic'] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

export interface ForgeProject {
  kind: ForgeKind;
  /** Числовой id или `group/name` GitLab, `owner/repo` GitHub — как в настройках или адресе remote. */
  ref: string;
  baseUrl: string;
  /** Настоящий адрес пуша: публикатор пушит на него явно, не по имени remote (у копии адрес закрыт). */
  pushUrl: string;
}

export interface ForgeAccount {
  id: string;
  username: string;
}

export interface ForgeMr {
  id: string;
  iid: number;
  url: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: string;
  createdAt: number;
  /** sha256 от `title + "\n" + body` — им сверка outbox доказывает, что правка MR дошла (G10). */
  bodyHash: string;
}

export interface ForgeNote {
  id: string;
  author: string;
  body: string;
  bodyHash: string;
  createdAt: number;
}

export interface ForgeThread {
  id: string;
  resolvable: boolean;
  resolved: boolean;
  notes: ForgeNote[];
}

/** Класс CI (05:80): `infra` — задание не дошло до скрипта, `code` — красный скрипт. */
export const CI_CLASSES = ['infra', 'code', 'green', 'pending', 'none'] as const;
export type CiClass = (typeof CI_CLASSES)[number];

export const FORGE_JOB_STATUSES = [
  'created',
  'pending',
  'running',
  'success',
  'failed',
  'canceled',
  'skipped',
] as const;
export type ForgeJobStatus = (typeof FORGE_JOB_STATUSES)[number];

export interface ForgeJob {
  id: string;
  name: string;
  status: ForgeJobStatus;
  /** Причина от форжа как есть (`failure_reason` GitLab, conclusion GitHub). */
  failureReason: string | null;
  startedAt: number | null;
  /** Скрипт стартовал? Отделяет `infra` (не стартовал, умер до скрипта) от красного кода. */
  scriptStarted: boolean | null;
}

export interface ForgePipeline {
  id: string;
  sha: string;
  status: ForgeJobStatus;
  createdAt: number;
  jobs: ForgeJob[];
}

export const FORGE_ACTIVITY_TYPES = [
  'push',
  'branch-delete',
  'mr-open',
  'mr-update',
  'note',
  'approval',
  'merge',
] as const;
export type ForgeActivityType = (typeof FORGE_ACTIVITY_TYPES)[number];

export interface ForgeActivity {
  id: string;
  type: ForgeActivityType;
  author: string;
  at: number;
  ref?: string;
  mrIid?: number;
  /** Id объекта, созданного событием (заметка, MR) — сверяется с результатами действий в журнале. */
  objectId?: string;
}

export type ForgeUnsupported = { unsupported: string };
/** Запись в форж: значение, «неизвестно» (исход не узнан — решает сверка outbox) или «не умеет». */
export type ForgeWrite<T> = { value: T } | { unknown: string } | ForgeUnsupported;

/**
 * Единственная поверхность форжа в ядре. Ни слияния, ни одобрения — их нет по построению (P63,
 * 05:7): статический тест обходит ключи и адреса каждого переходника.
 */
export interface ForgePort {
  readonly kind: ForgeKind;
  whoAmI(): Promise<Fact<ForgeAccount>>;
  mrBySourceBranch(q: {
    sourceBranch: string;
    createdAfter: number;
    author: string;
  }): Promise<Fact<ForgeMr>>;
  mr(iid: number): Promise<Fact<ForgeMr>>;
  createMr(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    body: string;
    draft: boolean;
  }): Promise<ForgeWrite<ForgeMr>>;
  updateMr(iid: number, input: { title?: string; body?: string }): Promise<ForgeWrite<ForgeMr>>;
  threads(iid: number): Promise<Fact<ForgeThread[]>>;
  reply(iid: number, threadId: string, body: string): Promise<ForgeWrite<ForgeNote>>;
  resolve(iid: number, threadId: string): Promise<ForgeWrite<true>>;
  /** Конфликт глазами форжа — дополняет локальный merge-tree, не заменяет его. */
  mergeability(iid: number): Promise<Fact<'clean' | 'conflict' | 'checking'>>;
  /** Читается ТОЛЬКО когда живое решение человека для ЭТОЙ задачи просило ждать CI (P64). */
  pipelines(q: { sha: string }): Promise<Fact<ForgePipeline[]>>;
  jobLogTail(jobId: string, maxBytes: number): Promise<Fact<string>>;
  activitySince(q: {
    since: number;
    refs: string[];
    mrIids: number[];
  }): Promise<Fact<ForgeActivity[]>>;
}
