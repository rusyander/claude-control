import { nearDuplicate, type SplitTicketCluster } from '@agentdeck/contracts/split-ticket-batch';
import { fingerprintOf, fingerprintsIn } from './compose.ts';
import type { TicketDraft } from './prepare.ts';

/**
 * Сверка с открытыми задачами трекера ДО заведения (ревизия 3): про то, что уже
 * открыто, панель пишет комментарий в эту задачу, а не заводит копию.
 *
 * Сверка по дефекту, а не по задаче целиком: в задаче из трёх дефектов
 * открытым может оказаться один — он уходит комментарием, два других заводятся.
 * Признаки, по убыванию силы:
 * - отпечаток находки (`agentdeck-fp:` в описании или комментарии) — её уже
 *   заводили или комментировали, пусть из другого разделения;
 * - название находки близко к названию задачи (`nearDuplicate`) — задачу
 *   завёл человек или другой инструмент.
 * Название, которое придумала модель, сверяется только у задачи из одного
 * дефекта: общее название связки слишком размыто, чтобы склеить по нему чужую задачу.
 */

/** Открытая задача трекера — то, что сверке нужно знать. */
export interface OpenTrackerIssue {
  key: string;
  summary: string;
  description: string;
}

/** Дефекты задачи, которые уходят комментарием в открытую задачу. */
export interface ExistingMatch {
  issue: OpenTrackerIssue;
  clusters: SplitTicketCluster[];
}

export interface SplitByExisting {
  comments: ExistingMatch[];
  /** Остаток — новая задача; нет — всё уже открыто. */
  rest?: TicketDraft;
}

function clusterMatch(
  cluster: SplitTicketCluster,
  open: readonly OpenTrackerIssue[],
  prints: readonly Set<string>[],
): OpenTrackerIssue | undefined {
  const own = cluster.tickets.map((ticket) => fingerprintOf(ticket.key));
  const byPrint = open.findIndex((_, index) => own.some((print) => prints[index]?.has(print)));
  if (byPrint >= 0) return open[byPrint];
  return open.find((issue) =>
    cluster.tickets.some((ticket) => nearDuplicate(ticket.title, issue.summary)),
  );
}

export function splitByExisting(
  draft: TicketDraft,
  open: readonly OpenTrackerIssue[],
): SplitByExisting {
  if (open.length === 0) return { comments: [], rest: draft };
  const prints = open.map((issue) => fingerprintsIn(issue.description));
  const single = draft.clusters.length === 1;
  const byKey = new Map<string, ExistingMatch>();
  const kept: SplitTicketCluster[] = [];
  for (const cluster of draft.clusters) {
    const issue =
      clusterMatch(cluster, open, prints) ??
      (single ? open.find((item) => nearDuplicate(draft.title, item.summary)) : undefined);
    if (!issue) {
      kept.push(cluster);
      continue;
    }
    const known = byKey.get(issue.key);
    if (known) known.clusters.push(cluster);
    else byKey.set(issue.key, { issue, clusters: [cluster] });
  }
  const comments = [...byKey.values()];
  if (kept.length === 0) return { comments };
  if (kept.length === draft.clusters.length) return { comments, rest: draft };
  // Часть ушла комментарием: название модели могло говорить и о ней — у
  // остатка из одного дефекта берём его собственное название.
  const ids = new Set(kept.map((cluster) => cluster.id));
  return {
    comments,
    rest: {
      ...draft,
      title: kept.length === 1 ? (kept[0]?.tickets[0]?.title ?? draft.title) : draft.title,
      clusters: kept,
      details: new Map([...draft.details].filter(([id]) => ids.has(id))),
    },
  };
}
