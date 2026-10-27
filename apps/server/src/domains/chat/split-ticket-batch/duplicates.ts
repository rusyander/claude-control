import {
  nearDuplicate,
  searchWords,
  similarTitle,
  type SplitTicketCluster,
  type SplitTicketDuplicate,
  type SplitTicketDuplicateDecision,
  type SplitTicketDuplicateReason,
} from '@agentdeck/contracts/split-ticket-batch';
import { fingerprintOf } from './compose.ts';
import type { OpenTrackerIssue } from './existing.ts';
import { NO_PRINTS, printsOf, type TicketPrints } from './prints.ts';

/**
 * Проверка на повторы ДО публикации (владелец 25.10.2026): панель ищет в Jira
 * открытые задачи про тот же дефект и ПОКАЗЫВАЕТ их человеку — связать
 * (комментарий в найденную), пропустить или всё же завести. Только чтение:
 * пишет потом публикация, по решению человека.
 *
 * Два источника: последние открытые задачи проекта (та же выборка, что у
 * сверки публикации) и поиск Jira по всему проекту — похожие слова названия и
 * задачи, за которыми память панели помнит отпечатки находок (`prints.ts`), и
 * старая строка `agentdeck-fp:` в тексте, — чтобы старая открытая задача за
 * пределами выборки тоже нашлась. Порог «похоже» ниже склеивающего: решает человек, а не сервер.
 */

/**
 * Запрос поиска похожих: значимые слова названия, отпечатки находок дефекта
 * (старые задачи несут их в тексте) и ключи задач, за которыми панель их помнит.
 */
export interface SimilarQuery {
  words: string[];
  prints: string[];
  keys: string[];
}

export interface DuplicateTracker {
  searchOpen: (projectKey: string) => Promise<OpenTrackerIssue[]>;
  /** Поиск Jira по проекту; нет — сверка только с последними открытыми. */
  searchSimilar?: (projectKey: string, query: SimilarQuery) => Promise<OpenTrackerIssue[]>;
  issueUrl: (key: string) => string;
}

interface Hit {
  issue: OpenTrackerIssue;
  reason: SplitTicketDuplicateReason;
}

/** Самый сильный довод по убыванию: отпечаток, близкое название, похожее название. */
export function matchDuplicate(
  cluster: SplitTicketCluster,
  issues: readonly OpenTrackerIssue[],
  memory: TicketPrints = NO_PRINTS,
): Hit | undefined {
  const own = new Set(cluster.tickets.map((ticket) => fingerprintOf(ticket.key)));
  const byPrint = issues.find((issue) =>
    [...printsOf(issue, memory)].some((print) => own.has(print)),
  );
  if (byPrint) return { issue: byPrint, reason: 'fingerprint' };
  const titles = cluster.tickets.map((ticket) => ticket.title);
  const near = issues.find((issue) => titles.some((title) => nearDuplicate(title, issue.summary)));
  if (near) return { issue: near, reason: 'title' };
  const similar = issues.find((issue) =>
    titles.some((title) => similarTitle(title, issue.summary)),
  );
  return similar ? { issue: similar, reason: 'similar' } : undefined;
}

const keysOf = (cluster: SplitTicketCluster): string[] =>
  cluster.tickets.map((ticket) => ticket.key);

export async function findDuplicates(
  tracker: DuplicateTracker,
  projectKey: string,
  clusters: readonly SplitTicketCluster[],
  memory: TicketPrints = NO_PRINTS,
): Promise<SplitTicketDuplicate[]> {
  if (clusters.length === 0) return [];
  const open = await tracker.searchOpen(projectKey);
  const found: SplitTicketDuplicate[] = [];
  for (const cluster of clusters) {
    const head = cluster.tickets[0];
    if (!head) continue;
    let hit = matchDuplicate(cluster, open, memory);
    if (!hit && tracker.searchSimilar) {
      const words = searchWords(head.title);
      const prints = [...new Set(keysOf(cluster).map(fingerprintOf))];
      const keys = memory.issuesWith(prints);
      const similar = await tracker.searchSimilar(projectKey, { words, prints, keys });
      hit = matchDuplicate(cluster, similar, memory);
    }
    if (!hit) continue;
    found.push({
      proposals: keysOf(cluster),
      title: head.title,
      issue: {
        key: hit.issue.key,
        summary: hit.issue.summary,
        url: tracker.issueUrl(hit.issue.key),
      },
      reason: hit.reason,
    });
  }
  return found;
}

/** Решение человека по одной склейке и задача, куда его применить. */
export interface ClusterDecision {
  choice: SplitTicketDuplicateDecision['choice'];
  issueKey?: string;
}

/** Ключ задачи этого проекта: `GOR-123` при проекте `GOR`; иное — не наше. */
function ownIssueKey(key: string | undefined, projectKey: string): string | undefined {
  const trimmed = key?.trim().toUpperCase() ?? '';
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(trimmed)) return undefined;
  return trimmed.startsWith(`${projectKey.trim().toUpperCase()}-`) ? trimmed : undefined;
}

/**
 * Решения тела запроса → по склейке (`C…`). Решение относится к склейке, если
 * его находка в ней; находка не из записи — решения нет. `link` без годного
 * ключа этого проекта — тоже нет: комментарий в чужую задачу из тела не уйдёт,
 * склейку сверит сервер, как без решения.
 */
export function decisionsByCluster(
  clusters: readonly SplitTicketCluster[],
  decisions: readonly SplitTicketDuplicateDecision[],
  projectKey: string,
): Map<string, ClusterDecision> {
  const byCluster = new Map<string, ClusterDecision>();
  for (const decision of decisions) {
    const cluster = clusters.find((item) =>
      item.tickets.some((ticket) => ticket.key === decision.proposal),
    );
    if (!cluster || byCluster.has(cluster.id)) continue;
    const issueKey = ownIssueKey(decision.issueKey, projectKey);
    if (decision.choice === 'link' && !issueKey) continue;
    byCluster.set(cluster.id, { choice: decision.choice, ...(issueKey ? { issueKey } : {}) });
  }
  return byCluster;
}
