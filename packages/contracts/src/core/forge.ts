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

/**
 * Выбор форжа по адресу — один чистый источник для ядра (`adapters/forge`, публикация) и панели
 * (дефекты, MR по ссылке). Хост адреса сравнивается с сайтом каждой включённой настройки (своя
 * инсталляция — её `baseUrl`, иначе облако вида). Совпадения нет — `generic` (пуш и ссылка), без
 * угадывания по слову в хосте: публикация чужим API хуже честного «этого форжа ядро не знает».
 * Свою политику «совпадения нет» панель держит у себя (`forgeOfHost` → её запасной выбор).
 */
export interface ForgeSite {
  enabled: boolean;
  /** Своя инсталляция; пусто — облако вида. */
  baseUrl: string;
  /** `group/name` или числовой id GitLab, `owner/repo` GitHub; пусто — из адреса remote. */
  repo: string;
}

export type HostedForgeKind = Exclude<ForgeKind, 'generic'>;
export type ForgeSites = Partial<Record<HostedForgeKind, ForgeSite>>;

export const FORGE_CLOUD: Readonly<Record<HostedForgeKind, string>> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
};

/** Порядок сверки сайтов: GitLab раньше GitHub (оба на одном хосте не живут, порядок — для детерминизма). */
const HOSTED_ORDER: readonly HostedForgeKind[] = ['gitlab', 'github'];

/** Хост адреса: `https://x/y`, `ssh://git@x:22/y`, `git@x:y` → `x`; пусто — не разобрать. */
export function hostOf(url: string | undefined): string {
  const text = url?.trim() ?? '';
  const scheme = text.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i);
  if (scheme?.[1]) return scheme[1].toLowerCase();
  const scp = text.match(/^[^@\s/]+@([^:/]+):/);
  return scp?.[1]?.toLowerCase() ?? '';
}

/** Путь проекта из адреса remote без `.git`; у своей инсталляции под путём — без него. */
export function projectPathOf(url: string, siteUrl = ''): string {
  const text = url.trim();
  let path: string;
  const scheme = text.match(/^[a-z+]+:\/\/[^/]+(\/.*)$/i);
  if (scheme?.[1]) path = scheme[1];
  else path = text.replace(/^[^@\s/]+@[^:/]+:/, '/');
  const sitePath = siteUrl ? siteUrl.replace(/^[a-z+]+:\/\/[^/]+/i, '').replace(/\/+$/, '') : '';
  if (sitePath && path.startsWith(`${sitePath}/`)) path = path.slice(sitePath.length);
  return path
    .replace(/^\/+/, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');
}

/** Адрес сайта вида: своя инсталляция без хвостового `/`, пусто — облако. */
export function siteBaseUrl(kind: HostedForgeKind, baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '') || FORGE_CLOUD[kind];
}

/** Вид включённого сайта, чей хост совпал с `host`; нет совпадения (или хост пуст) — `undefined`. */
export function forgeOfHost(host: string, sites: ForgeSites): HostedForgeKind | undefined {
  if (!host) return undefined;
  return HOSTED_ORDER.find((kind) => {
    const site = sites[kind];
    return site?.enabled === true && hostOf(siteBaseUrl(kind, site.baseUrl)) === host;
  });
}

export function selectForge(pushUrl: string, sites: ForgeSites): ForgeProject {
  const kind = forgeOfHost(hostOf(pushUrl), sites);
  const site = kind ? sites[kind] : undefined;
  if (kind && site) {
    const baseUrl = siteBaseUrl(kind, site.baseUrl);
    return { kind, ref: site.repo.trim() || projectPathOf(pushUrl, baseUrl), baseUrl, pushUrl };
  }
  return { kind: 'generic', ref: projectPathOf(pushUrl), baseUrl: '', pushUrl };
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
  /** Отдельная заметка в MR (не в нить): итог ревью по ссылке (этап 10, F8). */
  comment(iid: number, body: string): Promise<ForgeWrite<ForgeNote>>;
  /** Заметки MR: сверка `mr-comment` после краха ищет свою по хешу тела. */
  comments(iid: number): Promise<Fact<ForgeNote[]>>;
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

/** Задача форжа, назначенная мне (входящие, D16): ключ `<путь проекта>#<iid>`. */
export interface ForgeIssue {
  iid: number;
  project: string;
  title: string;
  url: string;
  labels: string[];
  /** sha256 значимых полей — изменился, запись входящих помечается. */
  digest: string;
  /** Этап 12 (D26): описание текстом — из него входящие берут названные пути. */
  description?: string;
  /** Эпик задачи (`<группа>&<номер>`), если форж его отдаёт. */
  epic?: string;
  /** Связанные задачи (`<путь проекта>#<iid>`), подсказка «связано с …». */
  links?: string[];
}

/** MR для входящих: на моё ревью или мой с нерешёнными нитями. Состояние — из `ForgePort.mr`. */
export interface ForgeInboxMr {
  iid: number;
  project: string;
  title: string;
  url: string;
  labels: string[];
  digest: string;
  /** Нерешённых нитей (для своего MR); для MR на ревью — 0. */
  openThreads: number;
}

/**
 * Чтения входящих с правами учётки человека (D16, fold m2): по всему сайту, не по одному проекту,
 * поэтому отдельно от `ForgePort` (тот — про один проект задачи). Каждое чтение — факт: «не умеет»
 * у форжа без такого API (GitHub — «не поддерживается»), «неизвестно» записей не трогает.
 */
export interface ForgeInbox {
  readonly kind: ForgeKind;
  /**
   * Задачи с КАЖДОЙ из меток; `assignedToMe: false` — чьи угодно (нужна хотя бы одна метка, иначе
   * читать нечего), нет поля или `true` — только назначенные на учётку.
   */
  assignedIssues(q: {
    labels: string[];
    assignedToMe?: boolean;
  }): Promise<Fact<ForgeIssue[]> | ForgeUnsupported>;
  reviewRequests(): Promise<Fact<ForgeInboxMr[]> | ForgeUnsupported>;
  ownMrsWithOpenThreads(): Promise<Fact<ForgeInboxMr[]> | ForgeUnsupported>;
}
