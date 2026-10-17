import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR, ensureRunDir } from '../../../lib/run-dir/run-dir.ts';
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
 */
export const TASK_TICKETS = `${RUN_DIR}/tickets.md`;

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

/** Текст файла: шапка с временем чтения, затем задачи по порядку. */
export function renderTickets(
  reads: readonly TicketRead[],
  skipped: readonly string[],
  at: string,
): string {
  const header =
    `# Tracker tasks — read by the panel at ${at}\n\n` +
    'Read this instead of the tracker. Go to the tracker only for attachment images, for a task ' +
    'not here, or to see what changed after the time above (compare `updated`). The panel ' +
    'rewrites this file at every group start — your own findings go into the notebook.\n';
  const rest = skipped.length
    ? `\nNot copied (over ${TICKETS_MAX} tasks): ${skipped.join(', ')} — read them in the tracker.\n`
    : '';
  return [header + rest, ...reads.map(renderIssue)].join('\n');
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
  const file = join(cwd, TASK_TICKETS);
  const temp = join(dir, `.tickets-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temp, renderTickets(reads, keys.slice(TICKETS_MAX), now().toISOString()));
  renameSync(temp, file);
  return { written: true, read: reads.length - failed, failed };
}
