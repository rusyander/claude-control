import type {
  ForgeActivity,
  ForgeActivityType,
  ForgeInboxMr,
  ForgeIssue,
  ForgeJob,
  ForgeJobStatus,
  ForgeMr,
  ForgeNote,
  ForgeThread,
} from '@agentdeck/contracts/core/forge';
import { FORGE_JOB_STATUSES } from '@agentdeck/contracts/core/forge';
import { asArray, isRecord, ms } from './http.ts';
import { mrBodyHash, noteHash, sha256Hex, stripDraft } from './hash.ts';

/**
 * Ответы GitLab v4 → типы ядра. Разбор строгий: нет обязательного поля — `null`, и метод
 * порта отвечает `unknown('garbage')`, а не значением с дырой. Экспортирован для таблицы
 * записанных ответов (P30) — она идёт через тот же разбор, что и живой порт.
 */

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function authorName(v: unknown): string | null {
  return isRecord(v) ? str(v.username) : null;
}

export function gitlabMr(v: unknown): ForgeMr | null {
  if (!isRecord(v)) return null;
  const iid = num(v.iid);
  const createdAt = ms(v.created_at);
  const author = authorName(v.author);
  const title = str(v.title);
  const source = str(v.source_branch);
  const target = str(v.target_branch);
  if (iid === null || createdAt === null || author === null || title === null) return null;
  if (source === null || target === null) return null;
  const clean = stripDraft(title);
  const body = str(v.description) ?? '';
  const state = v.state === 'merged' ? 'merged' : v.state === 'opened' ? 'open' : 'closed';
  return {
    id: String(v.id ?? iid),
    iid,
    url: str(v.web_url) ?? '',
    sourceBranch: source,
    targetBranch: target,
    headSha: str(v.sha),
    state,
    draft: v.draft === true || v.work_in_progress === true || clean !== title,
    author,
    createdAt,
    bodyHash: mrBodyHash(clean, body),
  };
}

/** Путь проекта из `references.full` (`group/name#12`, `group/name!7`) без хвоста номера. */
function projectOfRef(v: Record<string, unknown>, mark: '#' | '!'): string | null {
  const refs = isRecord(v.references) ? v.references : null;
  const full = refs ? str(refs.full) : null;
  const cut = full ? full.lastIndexOf(mark) : -1;
  return full && cut > 0 ? full.slice(0, cut) : null;
}

function labelsOf(v: unknown): string[] | null {
  const list = asArray(v);
  if (!list) return null;
  const out = list.filter((l): l is string => typeof l === 'string');
  return out.length === list.length ? out : null;
}

/**
 * Отпечаток для «тикет изменён»: заголовок, описание, метки (без порядка) и то, что
 * переходник добавил сам (нити, голова). Время правки не входит: комментарий — не правка.
 */
function digestOf(fields: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(fields));
}

/** Эпик задачи: `<группа>&<номер>` — одинаков у задач одного эпика (подсказка D26). */
function epicOf(v: Record<string, unknown>): string | undefined {
  const epic = isRecord(v.epic) ? v.epic : null;
  const iid = epic ? num(epic.iid) : null;
  const group = epic ? num(epic.group_id) : null;
  return iid !== null && group !== null ? `${group}&${iid}` : undefined;
}

/** Задача GitLab для входящих; `links` дочитывает порт отдельным запросом. */
export function gitlabIssue(v: unknown, links?: string[]): ForgeIssue | null {
  if (!isRecord(v)) return null;
  const iid = num(v.iid);
  const title = str(v.title);
  const url = str(v.web_url);
  const labels = labelsOf(v.labels);
  const project = projectOfRef(v, '#');
  if (iid === null || title === null || url === null || labels === null || project === null)
    return null;
  const description = str(v.description) ?? '';
  const epic = epicOf(v);
  const sorted = [...labels].sort();
  return {
    iid,
    project,
    title,
    url,
    labels,
    // Связи — отдельный запрос без гарантии порядка: в отпечатке отсортированы, как и метки.
    digest: digestOf({ title, description, labels: sorted, links: [...(links ?? [])].sort() }),
    ...(description ? { description } : {}),
    ...(epic ? { epic } : {}),
    ...(links ? { links } : {}),
  };
}

/** Ссылка связанной задачи — тот же ключ, что у записи входящих: `<путь проекта>#<iid>`. */
export function gitlabIssueLinks(v: unknown): string[] | null {
  const list = asArray(v);
  if (!list) return null;
  const out: string[] = [];
  for (const raw of list) {
    const issue = gitlabIssue(raw);
    if (!issue) return null;
    out.push(`${issue.project}#${issue.iid}`);
  }
  return out;
}

/** MR для входящих: личность и метки; нерешённые нити считает порт по обсуждениям. */
export function gitlabInboxMr(v: unknown, openThreads = 0): ForgeInboxMr | null {
  if (!isRecord(v)) return null;
  const iid = num(v.iid);
  const title = str(v.title);
  const url = str(v.web_url);
  const labels = labelsOf(v.labels);
  const project = projectOfRef(v, '!');
  if (iid === null || title === null || url === null || labels === null || project === null)
    return null;
  const description = str(v.description) ?? '';
  return {
    iid,
    project,
    title: stripDraft(title),
    url,
    labels,
    digest: digestOf({
      title,
      description,
      labels: [...labels].sort(),
      head: str(v.sha),
      openThreads,
    }),
    openThreads,
  };
}

/** Нерешённые нити MR: разрешимые и не разрешённые (системные заметки — не нити). */
export function gitlabOpenThreads(v: unknown): number | null {
  const threads = gitlabThreads(v);
  return threads ? threads.filter((t) => t.resolvable && !t.resolved).length : null;
}

export function gitlabMrList(v: unknown): ForgeMr[] | null {
  const list = asArray(v);
  if (!list) return null;
  const out = list.map(gitlabMr);
  return out.every((m): m is ForgeMr => m !== null) ? out : null;
}

const CHECKING = new Set(['checking', 'unchecked', 'preparing', 'approvals_syncing']);

export function gitlabMergeability(v: unknown): 'clean' | 'conflict' | 'checking' | null {
  if (!isRecord(v)) return null;
  if (v.has_conflicts === true || v.detailed_merge_status === 'conflict') return 'conflict';
  if (typeof v.detailed_merge_status === 'string' && CHECKING.has(v.detailed_merge_status))
    return 'checking';
  return 'clean';
}

export function gitlabNote(v: unknown): ForgeNote | null {
  if (!isRecord(v)) return null;
  const author = authorName(v.author);
  const body = str(v.body);
  const createdAt = ms(v.created_at);
  if (v.id === undefined || author === null || body === null || createdAt === null) return null;
  return { id: String(v.id), author, body, bodyHash: noteHash(body), createdAt };
}

export function gitlabThreads(v: unknown): ForgeThread[] | null {
  const list = asArray(v);
  if (!list) return null;
  const out: ForgeThread[] = [];
  for (const d of list) {
    if (!isRecord(d) || typeof d.id !== 'string') return null;
    const raw = asArray(d.notes);
    if (!raw) return null;
    // Системные заметки (смена ветки, метки) — не речь ревьюера.
    const human = raw.filter((n) => isRecord(n) && n.system !== true);
    const notes = human.map(gitlabNote);
    if (!notes.every((n): n is ForgeNote => n !== null)) return null;
    if (notes.length === 0) continue;
    const resolvable = human.some((n) => isRecord(n) && n.resolvable === true);
    const resolved =
      resolvable &&
      human.every((n) => !isRecord(n) || n.resolvable !== true || n.resolved === true);
    out.push({ id: d.id, resolvable, resolved, notes });
  }
  return out;
}

function jobStatus(v: unknown): ForgeJobStatus {
  return (FORGE_JOB_STATUSES as readonly unknown[]).includes(v) ? (v as ForgeJobStatus) : 'skipped';
}

/** Таймауты GitLab: машина CI или код — решает, начался ли скрипт (`scriptStarted` по логу). */
export const GITLAB_TIMEOUT_REASONS: ReadonlySet<string> = new Set([
  'job_execution_timeout',
  'stuck_or_timeout_failure',
]);

/**
 * Причины падения задания, за которыми стоит машина CI, а не код ветки: умер раннер, не ответил
 * API GitLab, сломался планировщик (перенос `INFRA_FAILURE_REASONS` наблюдателя MR панели).
 * Прочие причины — не доказанная машина: скрипт «неизвестно», красный судится кодом.
 */
export const GITLAB_INFRA_REASONS: ReadonlySet<string> = new Set([
  'runner_system_failure',
  'api_failure',
  'scheduler_failure',
  'data_integrity_failure',
]);

/**
 * Скрипт стартовал? `script_failure` — да; причина машины CI (`GITLAB_INFRA_REASONS`) — нет;
 * таймаут — по логу (`traceShowsScript`); без лога и при прочих причинах — неизвестно (`null`,
 * разбор CI судит красный кодом: машина не доказана). Не стартовало вовсе — нет.
 */
export function gitlabJob(v: unknown, trace?: string): ForgeJob | null {
  if (!isRecord(v) || v.id === undefined || typeof v.name !== 'string') return null;
  const status = jobStatus(v.status);
  const reason = str(v.failure_reason);
  const startedAt = ms(v.started_at);
  let scriptStarted: boolean | null = null;
  if (status === 'success') scriptStarted = true;
  else if (reason === 'script_failure') scriptStarted = true;
  else if (reason !== null && GITLAB_TIMEOUT_REASONS.has(reason))
    scriptStarted = trace === undefined ? null : traceShowsScript(trace);
  else if (reason !== null && GITLAB_INFRA_REASONS.has(reason)) scriptStarted = false;
  if (startedAt === null && status !== 'running' && status !== 'success') scriptStarted = false;
  return {
    id: String(v.id),
    name: v.name,
    status,
    failureReason: status === 'failed' ? (reason ?? null) : null,
    startedAt,
    scriptStarted,
  };
}

/** Раннер пишет разделы `section_start:`; раздела `step_script` нет — скрипт не начинался. */
export function traceShowsScript(trace: string): boolean {
  if (!/section_start:\d+:/.test(trace)) return true;
  return /section_start:\d+:step_script\b/.test(trace);
}

const ACTIONS: Record<string, ForgeActivityType> = {
  'pushed to': 'push',
  'pushed new': 'push',
  deleted: 'branch-delete',
  opened: 'mr-open',
  updated: 'mr-update',
  'commented on': 'note',
  approved: 'approval',
  accepted: 'merge',
};

/** Виды, которые бывают только у MR: без цели-MR такое событие — чужое (issue). */
const MR_TYPES = new Set<ForgeActivityType>(['mr-open', 'mr-update', 'merge', 'approval']);

function mrIidOf(v: Record<string, unknown>, type: ForgeActivityType): number | null {
  if (type === 'note') {
    const note = isRecord(v.note) ? v.note : null;
    return note?.noteable_type === 'MergeRequest' ? num(note.noteable_iid) : null;
  }
  return v.target_type === 'MergeRequest' ? num(v.target_iid) : null;
}

/** Событие проекта → активность; вид, которого порт не знает (вход в группу …), — `undefined`. */
export function gitlabActivity(v: unknown): ForgeActivity | null | undefined {
  if (!isRecord(v)) return null;
  const type = typeof v.action_name === 'string' ? ACTIONS[v.action_name] : undefined;
  if (!type) return undefined;
  const at = ms(v.created_at);
  const author = authorName(v.author);
  if (at === null || author === null || v.id === undefined) return null;
  const out: ForgeActivity = { id: String(v.id), type, author, at };
  const push = isRecord(v.push_data) ? v.push_data : null;
  if (push && typeof push.ref === 'string') out.ref = push.ref;
  // Номера issue и MR у GitLab — разные пространства: номер MR берётся только у цели-MR, иначе
  // заметка к issue №12 стала бы заметкой к MR !12.
  const iid = mrIidOf(v, type);
  // «opened»/«updated» у issue — не событие MR.
  if (iid === null && MR_TYPES.has(type)) return undefined;
  if (iid !== null) out.mrIid = iid;
  if (v.target_id !== null && v.target_id !== undefined) out.objectId = String(v.target_id);
  return out;
}
