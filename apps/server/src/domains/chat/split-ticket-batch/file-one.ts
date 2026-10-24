import type { SplitTicketCluster } from '@agentdeck/contracts/split-ticket-batch';
import type { SplitTicketProposal } from '@agentdeck/contracts/split-tickets';
import { commentBody, fingerprintLine, type TicketLang } from './compose.ts';
import { splitByExisting, type OpenTrackerIssue } from './existing.ts';
import type { TicketDraft } from './prepare.ts';
import type { TicketFiling } from './ticket-marks.ts';

/**
 * «Завести» одной строки хаба (L277) — та же сверка с открытыми задачами, что у
 * «Опубликовать в Jira» (ревизия 3, R3.6): иначе кнопка строки заводила бы копию
 * того, что публикация разом прокомментировала бы.
 *
 * Сверка — та же `splitByExisting` (отпечаток находки, потом близкое название),
 * комментарий — тот же `commentBody`, что пишет публикация. Поиск не удался —
 * отказ целиком: панель не заводит вслепую, человек нажмёт ещё раз.
 */

export interface OneTicketTracker {
  /** Открытые задачи проекта; отказ — ничего не заводится. */
  searchOpen: (projectKey: string) => Promise<OpenTrackerIssue[]>;
  comment: (key: string, body: string) => Promise<void>;
  create: (projectKey: string, summary: string, description: string) => Promise<string>;
}

export interface OneTicketInput {
  /** Ключ находки (`splitTicketKey`) — из него отпечаток. */
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
  const [match] = splitByExisting(draft, open).comments;
  if (match) {
    await tracker.comment(
      match.issue.key,
      commentBody({ ...draft, clusters: match.clusters }, input.lang),
    );
    return { key: match.issue.key, commented: true };
  }
  const description = [input.description || input.ticket.why, fingerprintLine([input.key])]
    .filter(Boolean)
    .join('\n\n');
  return tracker.create(input.projectKey, input.ticket.title, description);
}

/** Только поля предложения: отметки записи (`filed`, `taken`, `at`) в сверку не идут. */
function pick(ticket: SplitTicketProposal): SplitTicketProposal {
  return { title: ticket.title, where: ticket.where, why: ticket.why };
}
