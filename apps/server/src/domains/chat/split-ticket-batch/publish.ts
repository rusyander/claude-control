import {
  bundleSplitTickets,
  clusterSplitTickets,
  openSplitTickets,
  TICKET_BATCH_LABEL,
  type SplitTicketCluster,
  type SplitTicketDuplicateDecision,
  type SplitTicketPublished,
  type SplitTicketPublishFailure,
  type SplitTicketPublishedIssue,
  type SplitTicketSkipped,
} from '@agentdeck/contracts/split-ticket-batch';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { codeOf, coded } from '../../../lib/server-text/server-text.ts';
import {
  commentBody,
  draftSide,
  issueDescription,
  issueLabels,
  type TicketLang,
} from './compose.ts';
import { decisionsByCluster, type ClusterDecision, type SimilarQuery } from './duplicates.ts';
import { splitByExisting, type OpenTrackerIssue } from './existing.ts';
import { prepareTickets, type TicketAsk, type TicketDraft } from './prepare.ts';
import { DEFAULT_SEVERITY, priorityFor, priorityRejected } from './priority.ts';
import type { TicketPrints } from './prints.ts';
import type { SplitTicketMarks } from './ticket-marks.ts';

/**
 * «Опубликовать в Jira» (владелец 24.10.2026, ревизия 3): один клик человека —
 * его согласие. Конвейер детерминированный (`prepare.ts`): склейка повторов →
 * решения человека по похожим задачам (25.10) → связки → [модель] → описание
 * сервера → сверка с открытыми задачами трекера → комментарий в открытую или
 * новая задача. Упавшие остаются открытыми и запоминаются: «Повторить упавшие»
 * заводит ровно их, без второго прохода модели, но со свежей сверкой.
 *
 * Исполнителя публикация не шлёт НИКОГДА (владелец 25.10.2026): ни человека,
 * ни кого-то ещё. Если Jira назначила исполнителя сама (исполнитель проекта по
 * умолчанию), итог называет его, чтобы человек это увидел.
 */

export interface BatchIssueInput {
  projectKey: string;
  summary: string;
  description: string;
  issueType: string;
  labels: string[];
  priority?: string;
}

/** Заведённая задача: ключ и исполнитель, если Jira поставила его сама. */
export interface CreatedIssue {
  key: string;
  assignee?: string;
}

/** Трекер разом: приоритеты, открытые задачи проекта, заведение, комментарий, ссылка. */
export interface BatchTracker {
  priorities: () => Promise<string[]>;
  /** Открытые задачи проекта для сверки; отказ — публикация ничего не заводит. */
  searchOpen: (projectKey: string) => Promise<OpenTrackerIssue[]>;
  /** Поиск похожих по всему проекту — проверка на повторы перед публикацией. */
  searchSimilar?: (projectKey: string, query: SimilarQuery) => Promise<OpenTrackerIssue[]>;
  create: (input: BatchIssueInput) => Promise<CreatedIssue>;
  comment: (key: string, body: string) => Promise<void>;
  issueUrl: (key: string) => string;
}

export interface PublishDeps {
  marks: SplitTicketMarks;
  record: (parentChatId: string) => SplitPlanRecord | undefined;
  tracker: BatchTracker;
  /** Вызов модели; нет — по задаче на связку без неё. */
  ask?: TicketAsk;
  /** Память отпечатков панели (в трекер они не пишутся); нет — сверка без неё. */
  prints?: TicketPrints;
}

export interface PublishInput {
  parentChatId: string;
  projectKey: string;
  issueType: string;
  lang: TicketLang;
  retryFailed?: boolean;
  /** Решения человека из проверки на повторы; нет — сервер сверяет сам. */
  duplicates?: readonly SplitTicketDuplicateDecision[];
}

/** Упавшие задачи последней публикации по родителю — для «Повторить упавшие». */
interface FailedBatch {
  drafts: TicketDraft[];
  mode: SplitTicketPublished['mode'];
}

const failedMemo = new WeakMap<SplitTicketMarks, Map<string, FailedBatch>>();

function memoOf(marks: SplitTicketMarks): Map<string, FailedBatch> {
  let memo = failedMemo.get(marks);
  if (!memo) {
    memo = new Map();
    failedMemo.set(marks, memo);
  }
  return memo;
}

/**
 * Запомненные упавшие задачи — на сегодняшних склейках: находки, которые с тех
 * пор завели или взяли в чат, из задачи выпадают; задача без находок — тоже.
 */
function retryDrafts(
  remembered: readonly TicketDraft[],
  clusters: readonly SplitTicketCluster[],
): TicketDraft[] {
  const open = new Set(clusters.flatMap((cluster) => cluster.tickets.map((ticket) => ticket.key)));
  return remembered.flatMap((draft) => {
    const kept = draft.clusters
      .map((cluster) => ({
        ...cluster,
        tickets: cluster.tickets.filter((ticket) => open.has(ticket.key)),
      }))
      .filter((cluster) => cluster.tickets.length > 0);
    return kept.length > 0 ? [{ ...draft, clusters: kept }] : [];
  });
}

const keysOf = (clusters: readonly SplitTicketCluster[]): string[] =>
  clusters.flatMap((cluster) => cluster.tickets.map((ticket) => ticket.key));

/** Что склеено в задаче — окну: дефект и его повторы другими словами. */
const defectsOf = (clusters: readonly SplitTicketCluster[]) =>
  clusters.map((cluster) => ({
    title: cluster.tickets[0]?.title ?? cluster.id,
    duplicates: cluster.tickets.slice(1).map((ticket) => ticket.title),
  }));

const failureOf = (
  title: string,
  clusters: readonly SplitTicketCluster[],
  error: unknown,
): SplitTicketPublishFailure => ({
  title,
  proposals: keysOf(clusters),
  message: error instanceof Error ? error.message : String(error),
  ...codeOf(error),
});

/** Итог по задачам: второй комментарий в ту же задачу — та же строка, не вторая. */
function addIssue(issues: SplitTicketPublishedIssue[], next: SplitTicketPublishedIssue): void {
  const known = issues.find((issue) => issue.key === next.key);
  if (!known) {
    issues.push(next);
    return;
  }
  known.proposals = [...new Set([...known.proposals, ...next.proposals])];
  known.defects = [...known.defects, ...next.defects];
  known.created ||= next.created;
  if (next.commented) known.commented = true;
}

/** Склейки по решению человека: что связать, что пропустить, что заводить без сверки. */
interface Decided {
  link: { cluster: SplitTicketCluster; issueKey: string }[];
  skipped: SplitTicketSkipped[];
  /** Ключи находок «заведи всё равно» — сверка их не трогает. */
  exempt: Set<string>;
  /** Склейки, которые идут в задачи: без связанных и пропущенных. */
  working: SplitTicketCluster[];
}

function applyDecisions(
  clusters: readonly SplitTicketCluster[],
  byCluster: ReadonlyMap<string, ClusterDecision>,
  issueUrl: (key: string) => string,
): Decided {
  const decided: Decided = { link: [], skipped: [], exempt: new Set(), working: [] };
  for (const cluster of clusters) {
    const decision = byCluster.get(cluster.id);
    if (decision?.choice === 'link' && decision.issueKey) {
      decided.link.push({ cluster, issueKey: decision.issueKey });
    } else if (decision?.choice === 'skip') {
      decided.skipped.push({
        title: cluster.tickets[0]?.title ?? cluster.id,
        proposals: keysOf([cluster]),
        ...(decision.issueKey ? { key: decision.issueKey, url: issueUrl(decision.issueKey) } : {}),
      });
    } else {
      if (decision?.choice === 'create') {
        for (const key of keysOf([cluster])) decided.exempt.add(key);
      }
      decided.working.push(cluster);
    }
  }
  return decided;
}

/** Комментарий в задачу Jira про эти склейки и отметка их находок её ключом. */
async function commentInto(
  deps: PublishDeps,
  input: PublishInput,
  draft: TicketDraft,
  issue: { key: string; summary: string },
  issues: SplitTicketPublishedIssue[],
): Promise<void> {
  const done = await deps.marks.fileKeys(input.parentChatId, keysOf(draft.clusters), async () => {
    await deps.tracker.comment(issue.key, commentBody(draft, input.lang));
    deps.prints?.remember(issue.key, keysOf(draft.clusters));
    return { key: issue.key, commented: true };
  });
  addIssue(issues, {
    key: done.key,
    url: deps.tracker.issueUrl(done.key),
    title: issue.summary,
    proposals: done.created ? done.keys : keysOf(draft.clusters),
    created: false,
    ...(done.created ? { commented: true } : {}),
    defects: defectsOf(draft.clusters),
  });
}

/** Задача одной склейки без модели — для комментария по решению «связать». */
const linkDraft = (cluster: SplitTicketCluster): TicketDraft => ({
  title: cluster.tickets[0]?.title ?? cluster.id,
  summary: '',
  area: [],
  clusters: [cluster],
  details: new Map(),
});

export async function publishTickets(
  deps: PublishDeps,
  input: PublishInput,
): Promise<SplitTicketPublished> {
  return deps.marks.batch(input.parentChatId, async () => {
    const record = deps.record(input.parentChatId);
    const clusters = clusterSplitTickets(openSplitTickets(record?.groups ?? []));
    if (clusters.length === 0) {
      throw coded(
        new Error('Открытых предложений тикетов нет: все уже заведены или взяты в чат'),
        'split-ticket-batch-empty',
      );
    }
    const decided = applyDecisions(
      clusters,
      decisionsByCluster(clusters, input.duplicates ?? [], input.projectKey),
      deps.tracker.issueUrl,
    );
    const memo = memoOf(deps.marks);
    const remembered = input.retryFailed ? memo.get(input.parentChatId) : undefined;
    const retry = remembered ? retryDrafts(remembered.drafts, decided.working) : [];
    const prepared =
      remembered && retry.length > 0
        ? { drafts: retry, mode: remembered.mode }
        : decided.working.length > 0
          ? await prepareTickets(bundleSplitTickets(decided.working), deps.ask, input.lang)
          : { drafts: [], mode: deps.ask ? ('model' as const) : ('fallback' as const) };

    const issues: SplitTicketPublishedIssue[] = [];
    const failed: SplitTicketPublishFailure[] = [];
    const failedDrafts: TicketDraft[] = [];
    const skipped = decided.skipped;
    const remember = (draft: TicketDraft, error: unknown): void => {
      failedDrafts.push(draft);
      failed.push(failureOf(draft.title, draft.clusters, error));
    };
    const done = (): SplitTicketPublished => ({
      issues,
      failed,
      ...(skipped.length > 0 ? { skipped } : {}),
      mode: prepared.mode,
    });

    // «Связать» — человек сам выбрал задачу: комментарий в неё без сверки.
    for (const { cluster, issueKey } of decided.link) {
      const draft = linkDraft(cluster);
      try {
        await commentInto(deps, input, draft, { key: issueKey, summary: draft.title }, issues);
      } catch (error) {
        failed.push(failureOf(draft.title, draft.clusters, error));
      }
    }
    if (prepared.drafts.length === 0) return done();

    // Сверка ПЕРЕД заведением; не прочиталось — не заводим ничего: копия хуже
    // задержки, а «Повторить упавшие» сверит заново.
    let open: OpenTrackerIssue[];
    try {
      open = await deps.tracker.searchOpen(input.projectKey);
    } catch (error) {
      for (const draft of prepared.drafts) remember(draft, error);
      memo.set(input.parentChatId, { drafts: failedDrafts, mode: prepared.mode });
      return done();
    }

    // Приоритет — у каждой задачи (владелец 25.10.2026); отказ чтения списка
    // не роняет публикацию: серьёзность уйдёт меткой и строкой описания.
    const priorities = await deps.tracker.priorities().catch(() => [] as string[]);

    for (const draft of prepared.drafts) {
      const split = splitByExisting(draft, open, decided.exempt, deps.prints);
      for (const match of split.comments) {
        const part = { ...draft, clusters: match.clusters };
        try {
          await commentInto(deps, input, part, match.issue, issues);
        } catch (error) {
          remember(part, error);
        }
      }
      const rest = split.rest;
      if (!rest) continue;
      const keys = keysOf(rest.clusters);
      const severity = rest.severity ?? DEFAULT_SEVERITY;
      const side = draftSide(rest.clusters, rest.area);
      const mapped = priorityFor(severity, priorities);
      /** Описание и метки при этом приоритете: нет приоритета — серьёзность меткой. */
      const issueInput = (priority: string | undefined): BatchIssueInput => ({
        projectKey: input.projectKey,
        summary: rest.title,
        description: issueDescription(rest, input.lang, { side, severity, priority }),
        issueType: input.issueType,
        labels: issueLabels({
          side,
          area: rest.area,
          base: TICKET_BATCH_LABEL,
          ...(priority ? {} : { unmappedSeverity: severity }),
        }),
        ...(priority ? { priority } : {}),
      });
      let sent = issueInput(mapped);
      let assignee: string | undefined;
      try {
        const filed = await deps.marks.fileKeys(input.parentChatId, keys, async () => {
          const made = await deps.tracker.create(sent).catch(async (error: unknown) => {
            // Имя из общего списка, а схема проекта его не знает (или поля нет на
            // экране создания) — та же задача без приоритета, а не потерянная.
            if (!mapped || !priorityRejected(error)) throw error;
            sent = issueInput(undefined);
            return deps.tracker.create(sent);
          });
          assignee = made.assignee;
          // Отпечатки — в память панели, не в текст задачи (владелец 26.10.2026).
          deps.prints?.remember(made.key, keys);
          return made.key;
        });
        if (!filed.key) continue;
        // Заведённая — тоже открытая: следующая задача той же публикации сверится и с ней.
        open = [...open, { key: filed.key, summary: rest.title, description: sent.description }];
        addIssue(issues, {
          key: filed.key,
          url: deps.tracker.issueUrl(filed.key),
          title: rest.title,
          proposals: filed.created ? filed.keys : keys,
          created: filed.created,
          defects: defectsOf(rest.clusters),
          ...(filed.created ? { side } : {}),
          ...(filed.created && sent.priority ? { priority: sent.priority } : {}),
          ...(filed.created && assignee ? { assignee } : {}),
        });
      } catch (error) {
        remember(rest, error);
      }
    }
    if (failedDrafts.length > 0) {
      memo.set(input.parentChatId, { drafts: failedDrafts, mode: prepared.mode });
    } else memo.delete(input.parentChatId);
    return done();
  });
}
