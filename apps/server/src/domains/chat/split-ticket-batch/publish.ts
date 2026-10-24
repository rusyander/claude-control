import {
  bundleSplitTickets,
  clusterSplitTickets,
  openSplitTickets,
  TICKET_BATCH_LABEL,
  type SplitTicketCluster,
  type SplitTicketPublished,
  type SplitTicketPublishFailure,
  type SplitTicketPublishedIssue,
} from '@agentdeck/contracts/split-ticket-batch';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { codeOf, coded } from '../../../lib/server-text/server-text.ts';
import { commentBody, issueDescription, issueLabels, type TicketLang } from './compose.ts';
import { splitByExisting, type OpenTrackerIssue } from './existing.ts';
import { prepareTickets, type TicketAsk, type TicketDraft } from './prepare.ts';
import { priorityFor } from './priority.ts';
import type { SplitTicketMarks } from './ticket-marks.ts';

/**
 * «Опубликовать в Jira» (владелец 24.10.2026, ревизия 3): один клик человека —
 * его согласие. Конвейер детерминированный (`prepare.ts`): склейка повторов →
 * связки → [модель] → описание сервера → сверка с открытыми задачами трекера →
 * комментарий в открытую или новая задача. Упавшие остаются открытыми и
 * запоминаются: «Повторить упавшие» заводит ровно их, без второго прохода модели,
 * но со свежей сверкой.
 */

export interface BatchIssueInput {
  projectKey: string;
  summary: string;
  description: string;
  issueType: string;
  labels: string[];
  priority?: string;
}

/** Трекер разом: приоритеты, открытые задачи проекта, заведение, комментарий, ссылка. */
export interface BatchTracker {
  priorities: () => Promise<string[]>;
  /** Открытые задачи проекта для сверки; отказ — публикация ничего не заводит. */
  searchOpen: (projectKey: string) => Promise<OpenTrackerIssue[]>;
  create: (input: BatchIssueInput) => Promise<string>;
  comment: (key: string, body: string) => Promise<void>;
  issueUrl: (key: string) => string;
}

export interface PublishDeps {
  marks: SplitTicketMarks;
  record: (parentChatId: string) => SplitPlanRecord | undefined;
  tracker: BatchTracker;
  /** Вызов модели; нет — по задаче на связку без неё. */
  ask?: TicketAsk;
}

export interface PublishInput {
  parentChatId: string;
  projectKey: string;
  issueType: string;
  lang: TicketLang;
  retryFailed?: boolean;
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
    const memo = memoOf(deps.marks);
    const remembered = input.retryFailed ? memo.get(input.parentChatId) : undefined;
    const retry = remembered ? retryDrafts(remembered.drafts, clusters) : [];
    const prepared =
      remembered && retry.length > 0
        ? { drafts: retry, mode: remembered.mode }
        : await prepareTickets(bundleSplitTickets(clusters), deps.ask, input.lang);

    const issues: SplitTicketPublishedIssue[] = [];
    const failed: SplitTicketPublishFailure[] = [];
    const failedDrafts: TicketDraft[] = [];
    const remember = (draft: TicketDraft, error: unknown): void => {
      failedDrafts.push(draft);
      failed.push(failureOf(draft.title, draft.clusters, error));
    };

    // Сверка ПЕРЕД заведением; не прочиталось — не заводим ничего: копия хуже
    // задержки, а «Повторить упавшие» сверит заново.
    let open: OpenTrackerIssue[];
    try {
      open = await deps.tracker.searchOpen(input.projectKey);
    } catch (error) {
      for (const draft of prepared.drafts) remember(draft, error);
      memo.set(input.parentChatId, { drafts: failedDrafts, mode: prepared.mode });
      return { issues, failed, mode: prepared.mode };
    }

    // Приоритеты — один раз и только если есть что сопоставлять; отказ чтения
    // не роняет публикацию: серьёзность уйдёт меткой.
    let priorities: string[] = [];
    if (prepared.drafts.some((draft) => draft.severity)) {
      priorities = await deps.tracker.priorities().catch(() => []);
    }

    for (const draft of prepared.drafts) {
      const split = splitByExisting(draft, open);
      for (const match of split.comments) {
        const part = { ...draft, clusters: match.clusters };
        try {
          const done = await deps.marks.fileKeys(
            input.parentChatId,
            keysOf(match.clusters),
            async () => {
              await deps.tracker.comment(match.issue.key, commentBody(part, input.lang));
              return { key: match.issue.key, commented: true };
            },
          );
          addIssue(issues, {
            key: done.key,
            url: deps.tracker.issueUrl(done.key),
            title: match.issue.summary,
            proposals: done.created ? done.keys : keysOf(match.clusters),
            created: false,
            ...(done.created ? { commented: true } : {}),
            defects: defectsOf(match.clusters),
          });
        } catch (error) {
          remember(part, error);
        }
      }
      const rest = split.rest;
      if (!rest) continue;
      const keys = keysOf(rest.clusters);
      const priority = rest.severity ? priorityFor(rest.severity, priorities) : undefined;
      const unmapped = rest.severity && !priority ? rest.severity : undefined;
      const description = issueDescription(rest, input.lang, unmapped);
      try {
        const done = await deps.marks.fileKeys(input.parentChatId, keys, () =>
          deps.tracker.create({
            projectKey: input.projectKey,
            summary: rest.title,
            description,
            issueType: input.issueType,
            labels: issueLabels(rest.area, TICKET_BATCH_LABEL, unmapped),
            ...(priority ? { priority } : {}),
          }),
        );
        if (!done.key) continue;
        // Заведённая — тоже открытая: следующая задача той же публикации сверится и с ней.
        open = [...open, { key: done.key, summary: rest.title, description }];
        addIssue(issues, {
          key: done.key,
          url: deps.tracker.issueUrl(done.key),
          title: rest.title,
          proposals: done.created ? done.keys : keys,
          created: done.created,
          defects: defectsOf(rest.clusters),
        });
      } catch (error) {
        remember(rest, error);
      }
    }
    if (failedDrafts.length > 0) {
      memo.set(input.parentChatId, { drafts: failedDrafts, mode: prepared.mode });
    } else memo.delete(input.parentChatId);
    return { issues, failed, mode: prepared.mode };
  });
}
