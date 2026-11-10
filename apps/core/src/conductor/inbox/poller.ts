import type { ConfigView } from '@agentdeck/contracts/core/config';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeInbox, ForgeInboxMr, ForgeIssue } from '@agentdeck/contracts/core/forge';
import {
  INBOX_DEFAULTS,
  inboxItemSchema,
  type InboxItem,
  type InboxSource,
} from '@agentdeck/contracts/core/inbox';
import type { TrackerIssue } from '@agentdeck/trackers/jira.types';
import { quoteJql } from '@agentdeck/trackers/jira';
import type { CoreTracker } from '../../adapters/tracker/tracker.types.ts';
import type { BoardPort } from '../board/board.types.ts';
import { applyIntake, dedupeKey, withDigest, type IntakeResult } from './dedupe.ts';
import type { InboxPort } from './inbox.types.ts';
import { draftOf, pathsIn, sha256Of, telegramDraft, type InboxRead } from './kind.ts';
import { matchesForgeQuery, searchJqlOf } from './search-query.ts';

/**
 * Опрос и поиск входящих (этап 12, D16, P163, P167). Каждый источник читается как факт:
 * «неизвестно» (нет учётки, трекер не ответил, потолок страниц) записей не трогает и называет
 * причину. Круг опроса — один за раз (single-flight): пришедший во время круга получает тот же
 * круг, а не второй параллельный, — иначе два круга решили бы «ключа нет» оба. Записи кладутся
 * только через единственного писателя доски (`BoardPort.intake`); поиск не пишет ничего, создание
 * из поиска кладёт записи во «Входящие» и никогда не открывает задачу.
 */

/** Порт трекера/форжа панели: есть — порт и вид учётки; нет — причина. */
export type SourcePort<P> = { port: P } | { unknown: string };

export interface InboxPollerDeps {
  config(): { value: ConfigView } | { unknown: string };
  tracker(): SourcePort<CoreTracker>;
  forgeInbox(): SourcePort<ForgeInbox>;
  board(): BoardPort | undefined;
  /**
   * Автоочередь источника (D28, P183): включена в действующей настройке — `cmdId` записи
   * настройки человека, которая её включила; нет — `null` (записи ждут во «Входящих»).
   */
  autoQueueCmd(source: InboxSource): string | null;
  now(): number;
  note(message: string): void;
  /**
   * Этап 12 (W2-D, решение родителя): веб-адреса своих MR, которые уже ведёт опрос форжа ядра
   * (`mrUrlKey`). «Мой MR» из этого набора во «Входящие» не кладётся — «уже ведётся»: вторая
   * дорога открыла бы вторую задачу ответов по тому же MR. Нет — опрос форжа не собран.
   */
  watchedMrs?(): Promise<ReadonlySet<string>>;
}

export type SourceReport =
  /** `watched` — ключи «моих MR», пропущенных: их уже ведёт опрос форжа («уже ведётся»). */
  | { id: string; created: string[]; existing: string[]; marked: string[]; watched?: string[] }
  | { id: string; unknown: string };

/** Ключ сравнения веб-адреса MR: хвостовой `/` и регистр хоста не делают MR другим. */
export function mrUrlKey(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed;
  }
}

/** «Мои MR», которые уже ведёт опрос форжа, — вон из прочитанного; их ключи — в отчёт. */
async function withoutWatched(
  reads: readonly InboxRead[],
  deps: InboxPollerDeps,
): Promise<{ reads: InboxRead[]; watched: string[] }> {
  const own = reads.filter((r) => r.item.kind === 'own-mr' && r.item.url);
  if (own.length === 0 || !deps.watchedMrs) return { reads: [...reads], watched: [] };
  const set = await deps.watchedMrs();
  const isWatched = (r: InboxRead) =>
    r.item.kind === 'own-mr' && !!r.item.url && set.has(mrUrlKey(r.item.url));
  return {
    reads: reads.filter((r) => !isWatched(r)),
    watched: reads.filter(isWatched).map((r) => r.item.key),
  };
}

export interface InboxPoller {
  /** Один круг опроса; идёт круг — тот же круг. */
  poll(): Promise<SourceReport[]>;
  port: InboxPort;
}

const SEARCH_CACHE_MAX = 500;
const JIRA_POLL_LIMIT = 100;

const clean = (values: readonly unknown[] | undefined, max: number, len: number): string[] =>
  (values ?? [])
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim().slice(0, len))
    .slice(0, max);

/** Строка разобрана схемой строки входящих; не прошла — `null` (источник отдал не то). */
function itemOf(raw: InboxItem): InboxItem | null {
  const parsed = inboxItemSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Задача Jira → строка входящих: отпечаток — значимые поля, не статус и не исполнитель. Метки и
 * связи в отпечатке отсортированы: трекер вправе вернуть их в другом порядке, и это не правка.
 */
export function jiraRead(source: InboxSource, issue: TrackerIssue): InboxRead | null {
  const labels = clean(issue.labels, 50, 200);
  const links = clean(
    (issue.links ?? []).map((l) => l.key),
    100,
    200,
  );
  const digest = sha256Of(
    JSON.stringify([
      issue.summary,
      issue.description ?? '',
      issue.type,
      [...labels].sort(),
      issue.priority ?? '',
      issue.parent?.key ?? '',
      [...links].sort(),
    ]),
  );
  const item = itemOf({
    sourceId: source.id,
    system: 'jira',
    key: issue.key,
    kind: 'issue',
    title: (issue.summary.trim() || issue.key).slice(0, 500),
    url: issue.url,
    labels,
    ...(issue.type.trim() ? { type: issue.type.trim().slice(0, 100) } : {}),
    digest,
    related: {
      ...(issue.parent?.key ? { epic: issue.parent.key.slice(0, 200) } : {}),
      links,
      paths: pathsIn(issue.description),
    },
  });
  if (!item) return null;
  return {
    item,
    body: issue.description ?? '',
    fields: {
      ...(issue.status ? { status: issue.status } : {}),
      ...(issue.priority ? { priority: issue.priority } : {}),
    },
  };
}

function forgeIssueRead(source: InboxSource, issue: ForgeIssue): InboxRead | null {
  const item = itemOf({
    sourceId: source.id,
    system: 'gitlab',
    key: `${issue.project}#${issue.iid}`,
    kind: 'issue',
    title: (issue.title.trim() || `${issue.project}#${issue.iid}`).slice(0, 500),
    url: issue.url,
    labels: clean(issue.labels, 50, 200),
    digest: issue.digest,
    related: {
      ...(issue.epic ? { epic: issue.epic.slice(0, 200) } : {}),
      links: clean(issue.links, 100, 200),
      paths: pathsIn(issue.description),
    },
  });
  return item ? { item, body: issue.description ?? '' } : null;
}

function forgeMrRead(
  source: InboxSource,
  mr: ForgeInboxMr,
  kind: 'review-mr' | 'own-mr',
): InboxRead | null {
  const item = itemOf({
    sourceId: source.id,
    system: 'gitlab',
    key: `${mr.project}!${mr.iid}`,
    kind,
    title: (mr.title.trim() || `${mr.project}!${mr.iid}`).slice(0, 500),
    url: mr.url,
    labels: clean(mr.labels, 50, 200),
    digest: mr.digest,
    related: { links: [], paths: [] },
  });
  return item ? { item, body: '' } : null;
}

/** JQL опроса: сохранённый запрос источника, иначе метки + «мои», открытые, новые первыми. */
export function pollJql(source: Extract<InboxSource, { system: 'jira' }>): string | null {
  if (source.jira.jql?.trim()) return source.jira.jql.trim();
  const clauses: string[] = [];
  if (source.jira.labels.length > 0)
    clauses.push(`labels in (${source.jira.labels.map(quoteJql).join(', ')})`);
  if (source.jira.assignedToMe) clauses.push('assignee = currentUser()');
  if (clauses.length === 0) return null;
  clauses.push('statusCategory != Done');
  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}

/** `retryAfterMs` — трекер ответил 429/503 с `Retry-After`: источник ждёт этот срок. */
type Read =
  | { reads: InboxRead[]; truncated: boolean; dropped: number }
  | { unknown: string; retryAfterMs?: number };

function collect<T>(
  rows: readonly T[],
  to: (row: T) => InboxRead | null,
): { reads: InboxRead[]; dropped: number } {
  const reads: InboxRead[] = [];
  let dropped = 0;
  for (const row of rows) {
    const got = to(row);
    if (got) reads.push(got);
    else dropped += 1;
  }
  return { reads, dropped };
}

async function readJira(
  source: Extract<InboxSource, { system: 'jira' }>,
  deps: InboxPollerDeps,
  q: string | undefined,
): Promise<Read> {
  const jql = q === undefined ? pollJql(source) : searchJqlOf(q);
  if (!jql) return { unknown: `source ${source.id} names no labels, assignee or JQL` };
  const port = deps.tracker();
  if ('unknown' in port) return { unknown: port.unknown };
  const found = await port.port.search({ jql, limit: JIRA_POLL_LIMIT });
  if (!('value' in found)) {
    if (!('unknown' in found)) return { unknown: 'absent' };
    return 'retryAfterMs' in found
      ? { unknown: found.unknown, retryAfterMs: found.retryAfterMs }
      : { unknown: found.unknown };
  }
  const got = collect(found.value.issues, (issue) => jiraRead(source, issue));
  return { ...got, truncated: found.value.truncated };
}

function unsupportedOr<T>(
  fact: Fact<T[]> | { unsupported: string },
  where: string,
): T[] | { unknown: string } {
  if ('unsupported' in fact) return { unknown: `${where}: ${fact.unsupported}` };
  if ('value' in fact) return fact.value;
  if ('absent' in fact) return [];
  return { unknown: `${where}: ${fact.unknown}` };
}

async function readGitlab(
  source: Extract<InboxSource, { system: 'gitlab' }>,
  deps: InboxPollerDeps,
  q: string | undefined,
): Promise<Read> {
  const port = deps.forgeInbox();
  if ('unknown' in port) return { unknown: port.unknown };
  const inbox = port.port;
  const reads: InboxRead[] = [];
  let dropped = 0;
  const cfg = source.gitlab;
  if (cfg.issues.assignedToMe || cfg.issues.labels.length > 0) {
    const issues = unsupportedOr(
      await inbox.assignedIssues({
        labels: cfg.issues.labels,
        assignedToMe: cfg.issues.assignedToMe,
      }),
      'assigned issues',
    );
    if ('unknown' in issues) return issues;
    const got = collect(issues, (i) => forgeIssueRead(source, i));
    reads.push(...got.reads);
    dropped += got.dropped;
  }
  if (cfg.reviewerMrs) {
    const mrs = unsupportedOr(await inbox.reviewRequests(), 'review requests');
    if ('unknown' in mrs) return mrs;
    const got = collect(mrs, (m) => forgeMrRead(source, m, 'review-mr'));
    reads.push(...got.reads);
    dropped += got.dropped;
  }
  if (cfg.ownMrsWithThreads) {
    const mrs = unsupportedOr(await inbox.ownMrsWithOpenThreads(), 'own MRs');
    if ('unknown' in mrs) return mrs;
    const open = mrs.filter((m) => m.openThreads > 0);
    const got = collect(open, (m) => forgeMrRead(source, m, 'own-mr'));
    reads.push(...got.reads);
    dropped += got.dropped;
  }
  // Поиск по GitLab — по ключам и заголовкам прочитанных списков: своего языка запросов нет.
  const shown = reads.filter((r) => matchesForgeQuery(r, q));
  return { reads: shown, truncated: false, dropped };
}

export function sourcesOf(view: { value: ConfigView } | { unknown: string }): InboxSource[] {
  if ('unknown' in view) return [];
  return (view.value.doc.inbox ?? INBOX_DEFAULTS).sources;
}

export function createInboxPoller(deps: InboxPollerDeps): InboxPoller {
  let running: Promise<SourceReport[]> | null = null;
  // Последние прочитанные тикеты (тело снимка): создание из поиска берёт тело отсюда.
  const cache = new Map<string, InboxRead>();
  const remember = (read: InboxRead): void => {
    const key = `${read.item.sourceId}\u0000${read.item.key}`;
    cache.delete(key);
    cache.set(key, read);
    while (cache.size > SEARCH_CACHE_MAX) cache.delete(cache.keys().next().value!);
  };

  const readSource = (source: InboxSource, q?: string): Promise<Read> =>
    source.system === 'jira' ? readJira(source, deps, q) : readGitlab(source, deps, q);

  // Источник → до какого срока не стучаться (трекер ответил 429/503 с `Retry-After`). Без
  // заголовка срока нет: повторит следующий обычный круг. Память процесса: перезапуск ядра
  // просто спросит раньше и получит тот же ответ.
  const holdUntil = new Map<string, number>();

  const pollSource = async (source: InboxSource): Promise<SourceReport> => {
    const until = holdUntil.get(source.id);
    if (until !== undefined && deps.now() < until) {
      const reason = `rate-limited, retry after ${new Date(until).toISOString()}`;
      deps.note(`inbox: source ${source.id} held, entries untouched: ${reason}`);
      return { id: source.id, unknown: reason };
    }
    holdUntil.delete(source.id);
    let read: Read;
    try {
      read = await readSource(source);
    } catch (error) {
      read = { unknown: `read failed: ${(error as Error).message}` };
    }
    if ('unknown' in read) {
      if (read.retryAfterMs !== undefined && read.retryAfterMs > 0)
        holdUntil.set(source.id, deps.now() + read.retryAfterMs);
      deps.note(`inbox: source ${source.id} unread, entries untouched: ${read.unknown}`);
      return { id: source.id, unknown: read.unknown };
    }
    if (read.dropped > 0)
      deps.note(
        `inbox: source ${source.id}: ${read.dropped} item(s) not in the item shape, skipped`,
      );
    for (const r of read.reads) remember(r);
    const board = deps.board();
    if (!board?.intake) {
      deps.note(`inbox: source ${source.id} read, board not wired: nothing written`);
      return { id: source.id, unknown: 'board not wired' };
    }
    // Сбой набора «уже ведётся» или записи доски — «неизвестно» ЭТОГО источника: остальные
    // источники круга читаются и пишутся дальше (ревью W2-D), следующий круг повторит этот.
    try {
      const { reads, watched } = await withoutWatched(read.reads, deps);
      if (watched.length > 0)
        deps.note(
          `inbox: source ${source.id}: уже ведётся опросом форжа — ${watched.length} own MR(s) skipped: ${watched.join(', ')}`,
        );
      const at = deps.now();
      const drafts = reads.map((r) => withDigest(draftOf(source, r, at)));
      const cmdId = deps.autoQueueCmd(source);
      const got = board.intake<IntakeResult>(null, (file, ctx) => {
        const r = applyIntake(file, drafts, { ...ctx, queueBy: cmdId ? { cmdId } : null });
        return { write: r.created.length + r.marked.length > 0, created: r.created, value: r };
      });
      return { id: source.id, ...got, ...(watched.length > 0 ? { watched } : {}) };
    } catch (error) {
      const reason = `intake failed: ${(error as Error).message}`;
      deps.note(`inbox: source ${source.id} read, nothing written: ${reason}`);
      return { id: source.id, unknown: reason };
    }
  };

  const round = async (): Promise<SourceReport[]> => {
    const view = deps.config();
    if ('unknown' in view) {
      deps.note(`inbox: poll skipped, config unreadable: ${view.unknown}`);
      return [];
    }
    const out: SourceReport[] = [];
    for (const source of sourcesOf(view)) {
      if (!source.enabled) continue;
      out.push(await pollSource(source));
    }
    return out;
  };

  /** Что из тела уже лежит на доске под этими ключами (повтор отвечает тем же «уже были»). */
  const existingOf = (board: BoardPort, keys: string[], created: string[]): Promise<string[]> =>
    board.read().then((reply) => {
      const fresh = new Set(created);
      const byKey = new Map(
        reply.entries.map((e) => [dedupeKey(e.source), e.entryId] as const).filter(([k]) => k),
      );
      return keys
        .map((k) => byKey.get(k))
        .filter((id): id is string => id !== undefined && !fresh.has(id));
    });

  const bodyKeys = (input: Parameters<InboxPort['create']>[0]): string[] => {
    const view = deps.config();
    const create = input.create;
    if (create.source === 'telegram') return [dedupeKey({ kind: 'telegram', key: create.key })!];
    const source = sourcesOf(view).find((s) => s.id === create.sourceId);
    const kind = source?.system === 'gitlab' ? 'forge' : 'tracker';
    return create.items.map((i) => dedupeKey({ kind, system: create.sourceId, key: i.key })!);
  };

  const port: InboxPort = {
    async search(query) {
      const source = sourcesOf(deps.config()).find((s) => s.id === query.sourceId);
      if (!source)
        return {
          ok: false,
          status: 404,
          code: 'unknown-source',
          reason: `no inbox source ${query.sourceId} in the config`,
        };
      let read: Read;
      try {
        read = await readSource(source, query.q);
      } catch (error) {
        read = { unknown: `read failed: ${(error as Error).message}` };
      }
      if ('unknown' in read)
        return {
          ok: true,
          reply: { items: [], truncated: false, problem: `source ${source.id}: ${read.unknown}` },
        };
      for (const r of read.reads) remember(r);
      return {
        ok: true,
        reply: { items: read.reads.map((r) => r.item), truncated: read.truncated },
      };
    },
    async replayed(input) {
      const board = deps.board();
      if (!board) return undefined;
      const done = await board.replayed(input.cmdId);
      if (!done) return undefined;
      const created = done.created;
      return {
        created,
        existing: await existingOf(board, bodyKeys(input), created),
        replayed: true,
      };
    },
    async create(input) {
      const board = deps.board();
      if (!board?.intake)
        return { ok: false, status: 422, code: 'create-refused', problems: ['board not wired'] };
      const replay = await port.replayed?.(input);
      if (replay) return { ok: true, reply: replay };
      const create = input.create;
      const at = deps.now();
      let drafts: ReturnType<typeof withDigest>[];
      if (create.source === 'telegram') {
        // Репозитории `/task` — из настройки человека (`telegram.repos`); нет — запись без них.
        const view = deps.config();
        const repos = 'value' in view ? view.value.doc.telegram?.repos : undefined;
        drafts = [telegramDraft(create.text, create.key, repos)];
      } else {
        const source = sourcesOf(deps.config()).find((s) => s.id === create.sourceId);
        if (!source)
          return {
            ok: false,
            status: 404,
            code: 'unknown-source',
            problems: [`no inbox source ${create.sourceId} in the config`],
          };
        const foreign = create.items.filter(
          (i) => i.sourceId !== source.id || i.system !== source.system,
        );
        if (foreign.length > 0)
          return {
            ok: false,
            status: 422,
            code: 'create-refused',
            problems: foreign.map((i) => `item ${i.key} is not from source ${source.id}`),
          };
        drafts = create.items.map((item) => {
          const seen = cache.get(`${source.id}\u0000${item.key}`);
          const read = seen && seen.item.digest === item.digest ? seen : { item, body: '' };
          return withDigest(draftOf(source, { ...read, item }, at));
        });
      }
      const got = board.intake<IntakeResult>(input.cmdId, (file, ctx) => {
        // Создание человека — во «Входящие», никогда в очередь сама и никогда задача (P167).
        const r = applyIntake(file, drafts, { ...ctx, queueBy: null });
        return { write: true, created: r.created, value: r };
      });
      return { ok: true, reply: { created: got.created, existing: got.existing, replayed: false } };
    },
  };

  return {
    poll() {
      if (running) return running;
      running = round().finally(() => {
        running = null;
      });
      return running;
    },
    port,
  };
}
