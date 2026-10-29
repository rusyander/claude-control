import { nearDuplicate, type SplitTicketCluster } from '@agentdeck/contracts/split-ticket-batch';
import { fingerprintOf } from './compose.ts';
import type { TicketDraft } from './prepare.ts';
import { NO_PRINTS, printsOf, type OpenTrackerIssue, type TicketPrints } from './prints.ts';

/**
 * Сверка с открытыми задачами трекера ДО заведения (ревизия 3): про то, что уже
 * открыто, панель пишет комментарий в эту задачу, а не заводит копию.
 *
 * Сверка по дефекту, а не по задаче целиком: в задаче из трёх дефектов
 * открытым может оказаться один — он уходит комментарием, два других заводятся.
 * Признаки, по убыванию силы:
 * - отпечаток находки — её уже заводили или комментировали, пусть из другого
 *   разделения: память панели (`prints.ts`), у задач до 26.10.2026 — ещё и
 *   строка `agentdeck-fp:` в описании (только чтение);
 * - название находки близко к названию задачи (`nearDuplicate`) — задачу
 *   завёл человек или другой инструмент.
 * Название, которое придумала модель, сверяется только у задачи из одного
 * дефекта: общее название связки слишком размыто, чтобы склеить по нему чужую задачу.
 */

// Тип живёт в `prints.ts`: отпечатки читают задачу, а сверка — отпечатки; обратный импорт был циклом.
export type { OpenTrackerIssue } from './prints.ts';

/** Дефекты задачи, которые уходят комментарием в открытую задачу. */
interface ExistingMatch {
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

/**
 * `exempt` — ключи находок, про которые человек сказал «это другой дефект,
 * завести» (проверка на повторы, 25.10.2026): их склейки не сверяются вовсе.
 */
export function splitByExisting(
  draft: TicketDraft,
  open: readonly OpenTrackerIssue[],
  exempt: ReadonlySet<string> = new Set(),
  memory: TicketPrints = NO_PRINTS,
): SplitByExisting {
  if (open.length === 0) return { comments: [], rest: draft };
  const prints = open.map((issue) => printsOf(issue, memory));
  const single = draft.clusters.length === 1;
  const byKey = new Map<string, ExistingMatch>();
  const kept: SplitTicketCluster[] = [];
  for (const cluster of draft.clusters) {
    const free = cluster.tickets.some((ticket) => exempt.has(ticket.key));
    const issue = free
      ? undefined
      : (clusterMatch(cluster, open, prints) ??
        (single ? open.find((item) => nearDuplicate(draft.title, item.summary)) : undefined));
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
