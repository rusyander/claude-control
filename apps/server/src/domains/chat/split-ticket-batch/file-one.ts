import {
  TICKET_BATCH_LABEL,
  type SplitTicketCluster,
} from '@agentdeck/contracts/split-ticket-batch';
import type { SplitTicketProposal } from '@agentdeck/contracts/split-tickets';
import { commentBody, draftSide, issueHeader, issueLabels, type TicketLang } from './compose.ts';
import { splitByExisting, type OpenTrackerIssue } from './existing.ts';
import type { TicketDraft } from './prepare.ts';
import { DEFAULT_SEVERITY, priorityFor, priorityRejected } from './priority.ts';
import { NO_PRINTS, type TicketPrints } from './prints.ts';
import type { TicketFiling } from './ticket-marks.ts';

/**
 * «Завести» одной строки хаба (L277) — та же сверка с открытыми задачами, что у
 * «Опубликовать в Jira» (ревизия 3, R3.6): иначе кнопка строки заводила бы копию
 * того, что публикация разом прокомментировала бы.
 *
 * Сверка — та же `splitByExisting` (отпечаток находки из памяти панели, потом близкое название),
 * комментарий — тот же `commentBody`, что пишет публикация. Поиск не удался —
 * отказ целиком: панель не заводит вслепую, человек нажмёт ещё раз.
 */

/** Что уходит в трекер новой задачей. Исполнителя нет и не будет. */
export interface OneTicketIssue {
  projectKey: string;
  summary: string;
  description: string;
  labels: string[];
  priority?: string;
}

export interface OneTicketTracker {
  /** Открытые задачи проекта; отказ — ничего не заводится. */
  searchOpen: (projectKey: string) => Promise<OpenTrackerIssue[]>;
  comment: (key: string, body: string) => Promise<void>;
  /** Имена приоритетов установки; нет или отказ — без приоритета, серьёзность меткой. */
  priorities?: () => Promise<string[]>;
  create: (issue: OneTicketIssue) => Promise<string>;
}

export interface OneTicketInput {
  /** Ключ находки (`splitTicketKey`) — из него отпечаток в памяти панели. */
  key: string;
  ticket: SplitTicketProposal;
  /** Группы, нашедшие находку, — строка «Нашли группы» комментария. */
  groups: string[];
  projectKey: string;
  /** Описание хаба на языке интерфейса; пусто — «почему» находки. */
  description: string;
  lang: TicketLang;
}

export async function fileOneTicket(
  tracker: OneTicketTracker,
  input: OneTicketInput,
  prints: TicketPrints = NO_PRINTS,
): Promise<TicketFiling> {
  const open = await tracker.searchOpen(input.projectKey);
  const cluster: SplitTicketCluster = {
    id: 'C1',
    tickets: [{ key: input.key, ...pick(input.ticket), groups: input.groups }],
  };
  const draft: TicketDraft = {
    title: input.ticket.title,
    summary: '',
    area: [],
    clusters: [cluster],
    details: new Map(),
  };
  const [match] = splitByExisting(draft, open, new Set(), prints).comments;
  if (match) {
    await tracker.comment(
      match.issue.key,
      commentBody({ ...draft, clusters: match.clusters }, input.lang),
    );
    prints.remember(match.issue.key, [input.key]);
    return { key: match.issue.key, commented: true };
  }
  // Сторона и приоритет — как у публикации разом (владелец 25.10.2026): метка и
  // первая строка описания; серьёзности строка хаба не знает — средняя.
  const side = draftSide(draft.clusters, []);
  const severity = DEFAULT_SEVERITY;
  const priorities = tracker.priorities ? await tracker.priorities().catch(() => []) : [];
  const mapped = priorityFor(severity, priorities);
  const issueOf = (priority: string | undefined): OneTicketIssue => ({
    projectKey: input.projectKey,
    summary: input.ticket.title,
    description: [
      issueHeader({ side, severity, ...(priority ? { priority } : {}) }, input.lang),
      input.description || input.ticket.why,
    ]
      .filter(Boolean)
      .join('\n\n'),
    labels: issueLabels({
      side,
      area: [],
      base: TICKET_BATCH_LABEL,
      ...(priority ? {} : { unmappedSeverity: severity }),
    }),
    ...(priority ? { priority } : {}),
  });
  const key = await tracker.create(issueOf(mapped)).catch((error: unknown) => {
    if (!mapped || !priorityRejected(error)) throw error;
    return tracker.create(issueOf(undefined));
  });
  // Отпечаток — в память панели, не в текст задачи (владелец 26.10.2026).
  prints.remember(key, [input.key]);
  return key;
}

/** Только поля предложения: отметки записи (`filed`, `taken`, `at`) в сверку не идут. */
function pick(ticket: SplitTicketProposal): SplitTicketProposal {
  return { title: ticket.title, where: ticket.where, why: ticket.why };
}
