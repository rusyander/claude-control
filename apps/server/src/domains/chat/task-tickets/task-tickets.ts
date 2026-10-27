import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_TICKETS_FILE } from '@agentdeck/contracts/quality-floor';
import type { SieveReportRow } from '@agentdeck/contracts/sieves';
import type { JiraIssueBrief } from '../../integrations/atlassian/jira.ts';
import { ensureRunDir } from '../../../lib/run-dir/run-dir.ts';
import { unmappedPoints, type UnmappedPoints } from '../ticket-points/ticket-points.ts';
import type { TicketRead, TicketSeedResult, TicketSource } from './task-tickets.types.ts';

/**
 * Задачи трекера группы — один раз, панелью (9.5 плана экономии, 17.10.2026).
 * Разбор при разделении уже читал задачи, а каждая группа потом читала их
 * заново через MCP: полный ответ трекера (описание, комментарии, служебные
 * поля) ложился в её контекст и перечитывался каждым следующим вызовом. Панель
 * читает задачи своим клиентом Jira и кладёт текст в копию — это просто файл,
 * его видит любой CLI. В трекер группа ходит только за изменениями, картинками
 * вложений и задачами, которых в файле нет.
 *
 * Файл — панели, не агента: при каждом старте группы он пишется заново (свежее
 * чтение лучше вчерашнего), а свои находки агент пишет в тетрадь (9.2).
 * Путь — общий с контрактами: по нему строка следа задач называет файл, а
 * доставка сверяет цитаты строк `task-N` (тест держит его в `RUN_DIR`).
 */
export const TASK_TICKETS = TASK_TICKETS_FILE;

/**
 * Полный текст задач, не менявшихся после доставки, — рядом, а не в файле задач (аудит g9
 * 27.10, R6): задание перепроверки просило не перечитывать их разделы, а группа прочла
 * весь файл (11k при контексте 201k). В файле задач у них строка-указатель; этот файл —
 * только чтобы процитировать пункт заново, и его же читает проверка доставки.
 */
export const TASK_TICKETS_STANDING = TASK_TICKETS.replace(/\.md$/u, '-unchanged.md');

/** Больше задач в одной группе не бывает по делу; лишние названы, но не прочитаны. */
const TICKETS_MAX = 8;
const DESCRIPTION_MAX = 6000;
/** Последние комментарии — в них уточнения и приёмка; старые обычно уже учтены в описании. */
const COMMENTS_MAX = 15;
const COMMENT_MAX = 1500;

const clip = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max).trimEnd()}\n… (cut at ${max} chars — the rest is in the tracker)`;

function renderIssue(read: TicketRead): string {
  if ('reason' in read)
    return `## ${read.key}\n\nNot read by the panel (${read.reason}) — read it in the tracker.\n`;
  const { issue } = read;
  const head = [
    `## ${issue.key} — ${issue.summary}`,
    '',
    [
      `Status: ${issue.status}`,
      issue.type ? `type: ${issue.type}` : '',
      issue.assignee ? `assignee: ${issue.assignee}` : '',
      issue.updatedAt ? `updated: ${issue.updatedAt}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    issue.url,
  ];
  const body = issue.description?.trim()
    ? ['', '### Description', '', clip(issue.description.trim(), DESCRIPTION_MAX)]
    : ['', '(no description)'];
  const shown = issue.comments.slice(-COMMENTS_MAX);
  const comments = shown.length
    ? [
        '',
        `### Comments (${issue.comments.length}${issue.comments.length > shown.length ? `, last ${shown.length}` : ''})`,
        ...shown.flatMap((comment) => [
          '',
          `**${comment.author || '?'}** · ${comment.created}`,
          clip(comment.body.trim(), COMMENT_MAX),
        ]),
      ]
    : [];
  const files = issue.attachments.length
    ? [
        '',
        `### Attachments (open in the tracker if needed)`,
        '',
        ...issue.attachments.map((file) => `- ${file.name}`),
      ]
    : [];
  const links = issue.links.length
    ? [
        '',
        '### Links',
        '',
        ...issue.links.map((link) => `- ${link.relation} ${link.key} — ${link.summary}`),
      ]
    : [];
  return [...head, ...body, ...comments, ...files, ...links, ''].join('\n');
}

function renderPointer(issue: JiraIssueBrief, since: string | undefined): string {
  return (
    `## ${issue.key} — ${issue.summary}\n\nNot updated in the tracker since the last delivery` +
    `${since ? ` (${since})` : ''} — its points stand as reported; do not re-read it. Its full ` +
    `text, only to quote a point again: \`${TASK_TICKETS_STANDING}\`.\n`
  );
}

/** Задачи, у которых в файле задач строка-указатель, а текст — в `TASK_TICKETS_STANDING`. */
export interface StandingTickets {
  keys: ReadonlySet<string>;
  /** Последняя доставка группы — с чем сравнивали. */
  since?: string;
}

/** Текст файла: шапка с временем чтения, затем задачи по порядку. */
export function renderTickets(
  reads: readonly TicketRead[],
  skipped: readonly string[],
  at: string,
  standing?: StandingTickets,
): string {
  const header =
    `# Tracker tasks — read by the panel at ${at}\n\n` +
    'Read this instead of the tracker. Go to the tracker only for attachment images, for a task ' +
    'not here, or to see what changed after the time above (compare `updated`). The panel ' +
    'rewrites this file at every group start — your own findings go into the notebook.\n';
  const rest = skipped.length
    ? `\nNot copied (over ${TICKETS_MAX} tasks): ${skipped.join(', ')} — read them in the tracker.\n`
    : '';
  const section = (read: TicketRead): string =>
    !('reason' in read) && standing?.keys.has(read.key)
      ? renderPointer(read.issue, standing.since)
      : renderIssue(read);
  return [header + rest, ...reads.map(section)].join('\n');
}

/** Запись через временный файл: агент никогда не прочтёт половину. */
function writeWhole(dir: string, file: string, text: string): void {
  const temp = join(dir, `.tickets-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temp, text);
  renameSync(temp, file);
}

/**
 * Прочитать задачи группы и положить их в копию. Нет ключей или нет трекера —
 * файла нет, и группа ведёт себя как раньше. Ошибка чтения одной задачи не
 * роняет остальные: она названа в файле с причиной. Запись — через временный
 * файл, чтобы агент никогда не прочёл половину.
 */
export async function seedTaskTickets(
  cwd: string,
  keys: readonly string[],
  source: TicketSource | undefined,
  now: () => Date = () => new Date(),
  /** Перепроверка: задача не менялась после доставки — в файле задач только указатель. */
  standing?: { stands: (issue: JiraIssueBrief) => boolean; since?: string },
): Promise<TicketSeedResult> {
  if (!keys.length || !source?.connected()) return { written: false, read: 0, failed: 0 };
  const taken = keys.slice(0, TICKETS_MAX);
  const reads: TicketRead[] = await Promise.all(
    taken.map(async (key) => {
      try {
        return { key, issue: await source.read(key) };
      } catch (error) {
        return { key, reason: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const failed = reads.filter((item) => 'reason' in item).length;
  const dir = ensureRunDir(cwd);
  const at = now().toISOString();
  const stands = reads.filter(
    (item): item is Extract<TicketRead, { issue: JiraIssueBrief }> =>
      !('reason' in item) && standing?.stands(item.issue) === true,
  );
  const keysStanding = new Set(stands.map((item) => item.key));
  writeWhole(
    dir,
    join(cwd, TASK_TICKETS),
    renderTickets(reads, keys.slice(TICKETS_MAX), at, {
      keys: keysStanding,
      ...(standing?.since ? { since: standing.since } : {}),
    }),
  );
  // Файл прежних задач — только этого чтения: от прошлой перепроверки он не остаётся.
  const standingFile = join(cwd, TASK_TICKETS_STANDING);
  if (stands.length > 0) writeWhole(dir, standingFile, renderTickets(stands, [], at));
  else rmSync(standingFile, { force: true });
  return {
    written: true,
    read: reads.length - failed,
    failed,
    at,
    tickets: reads.map((item) =>
      'reason' in item
        ? { key: item.key, reason: item.reason }
        : { key: item.key, ...(item.issue.updatedAt ? { updatedAt: item.issue.updatedAt } : {}) },
    ),
    skipped: keys.slice(TICKETS_MAX),
  };
}

const readOptional = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Текст задач, который панель положила в копию, вместе с полным текстом прежних задач
 * (`TASK_TICKETS_STANDING`) — цитату пункта ищут в обоих; файла задач нет — `undefined`.
 */
export function readTaskTickets(cwd: string): string | undefined {
  const tickets = readOptional(join(cwd, TASK_TICKETS));
  if (tickets === undefined) return undefined;
  const standing = readOptional(join(cwd, TASK_TICKETS_STANDING));
  return standing === undefined ? tickets : `${tickets}\n${standing}`;
}

/** Задачи группы глазами «Перепроверить MR»: что изменилось в трекере после доставки. */
export interface RecheckTickets {
  /** Когда панель перечитала задачи в копию. */
  at: string;
  /** С чем сравнивали — последняя доставка группы; нет — изменёнными считаются все. */
  since?: string;
  /** Ключи задач, обновлённых в трекере после `since`, — с временем обновления. */
  changed: { key: string; updatedAt?: string }[];
  /** Ключи задач без изменений после `since`, у которых каждый пункт покрыт строкой следа. */
  unchanged: string[];
  /**
   * Задачи без изменений после `since`, но с пунктами, которых не цитирует ни одна сданная
   * строка `task-N` (аудит g5 27.10, H1), — с этими пунктами дословно. В файле задач у них
   * полный раздел, не указатель.
   */
  owed?: UnmappedPoints[];
  /** Ключи, которых в файле нет: не прочитаны (с причиной) или сверх предела. */
  unread: string[];
}

/**
 * Перечитать задачи группы к «Перепроверить MR» (аудит g0 26.10, F3): задание требовало
 * «прочесть каждый тикет целиком», девять полных чтений через MCP на перепроверку —
 * и группа не прочла ни одного. Панель перечитывает их тем же доступом, что при старте
 * группы (запрос из процесса панели, в контекст группы не ложится), и делит на
 * изменённые после доставки и прежние: заново раскладывать на пункты нужно только первые.
 * Трекера нет или ключей нет — `undefined`, и задание просит прочесть трекер, как раньше.
 */
export async function recheckTickets(
  cwd: string,
  keys: readonly string[],
  source: TicketSource | undefined,
  since: string | undefined,
  now: () => Date = () => new Date(),
  /**
   * Сданные строки группы со следом задач (`sieveRows`); заданы — задача «стоит как сдана»,
   * только когда каждый её пункт цитирует строка `task-N` (аудит g5 27.10, H1). Нет следа —
   * не задано: судить пункты не по чему.
   */
  rows?: readonly SieveReportRow[],
): Promise<RecheckTickets | undefined> {
  const bound = since ? Date.parse(since) : Number.NaN;
  // Время Jira со смещением без двоеточия (`+0300`) Node разбирает сам — тест это держит.
  // Время не разобрать или доставки не было — сравнить не с чем: задача «изменена».
  const stands = (updatedAt: string | undefined): boolean => {
    const updated = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    return Number.isFinite(bound) && Number.isFinite(updated) && updated <= bound;
  };
  const owed = new Map<string, string[]>();
  const seed = await seedTaskTickets(cwd, keys, source, now, {
    stands: (issue) => {
      if (!stands(issue.updatedAt)) return false;
      if (rows === undefined) return true;
      const points = unmappedPoints(renderIssue({ key: issue.key, issue }), rows)[0]?.points;
      if (points?.length) owed.set(issue.key, points);
      return !points?.length;
    },
    ...(since ? { since } : {}),
  });
  if (!seed.written || !seed.at) return undefined;
  const changed: RecheckTickets['changed'] = [];
  const unchanged: string[] = [];
  const owedList: UnmappedPoints[] = [];
  const unread: string[] = [...(seed.skipped ?? []).map((key) => `${key} — over the limit`)];
  for (const ticket of seed.tickets ?? []) {
    if ('reason' in ticket) {
      unread.push(`${ticket.key} — ${ticket.reason}`);
      continue;
    }
    const points = owed.get(ticket.key);
    if (points) {
      owedList.push({ key: ticket.key, points });
    } else if (stands(ticket.updatedAt)) {
      unchanged.push(ticket.key);
    } else {
      changed.push({
        key: ticket.key,
        ...(ticket.updatedAt ? { updatedAt: ticket.updatedAt } : {}),
      });
    }
  }
  return {
    at: seed.at,
    ...(since ? { since } : {}),
    changed,
    unchanged,
    ...(owedList.length > 0 ? { owed: owedList } : {}),
    unread,
  };
}
