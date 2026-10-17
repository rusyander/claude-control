import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JiraIssueBrief } from '../../integrations/atlassian/jira.ts';
import { TASK_TICKETS, seedTaskTickets } from './task-tickets.ts';
import type { TicketSource } from './task-tickets.types.ts';

/**
 * Задачи трекера в копии группы (9.5): что панель кладёт в файл и когда не
 * кладёт ничего. Трекер подменён источником: разбор ответа Jira проверяет
 * `atlassian.test.ts` (`readIssueBrief`), здесь — файл, который увидит агент.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-tickets-'));
  dirs.push(dir);
  return dir;
}

const issue = (key: string, extra: Partial<JiraIssueBrief> = {}): JiraIssueBrief => ({
  key,
  summary: `Задача ${key}`,
  status: 'В работе',
  type: 'Story',
  url: `https://tracker.example.com/browse/${key}`,
  updatedAt: '2026-10-17T10:00:00.000+0000',
  description: `Описание ${key}`,
  comments: [],
  attachments: [],
  links: [],
  ...extra,
});

function source(
  issues: Record<string, JiraIssueBrief | Error>,
  connected = true,
): TicketSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    connected: () => connected,
    read: (key) => {
      asked.push(key);
      const found = issues[key];
      if (found instanceof Error) return Promise.reject(found);
      return found ? Promise.resolve(found) : Promise.reject(new Error(`404 ${key}`));
    },
  };
}

const AT = () => new Date('2026-10-17T12:00:00.000Z');
const fileOf = (dir: string): string => readFileSync(join(dir, TASK_TICKETS), 'utf8');

describe('task-tickets: задачи трекера группы в её копии', () => {
  it('описание, последние комментарии, вложения и связи — в файле, время чтения в шапке', async () => {
    const dir = copyDir();
    const comments = Array.from({ length: 20 }, (_, i) => ({
      author: `Автор ${i + 1}`,
      created: `2026-10-${String(i + 1).padStart(2, '0')}`,
      body: `комментарий ${i + 1}`,
    }));
    const result = await seedTaskTickets(
      dir,
      ['PROJ-1'],
      source({
        'PROJ-1': issue('PROJ-1', {
          comments,
          attachments: [{ name: 'макет.png', mimeType: 'image/png' }],
          links: [{ relation: 'blocks', key: 'PROJ-2', summary: 'Импорт' }],
        }),
      }),
      AT,
    );

    expect(result).toEqual({ written: true, read: 1, failed: 0 });
    const text = fileOf(dir);
    expect(text).toContain('read by the panel at 2026-10-17T12:00:00.000Z');
    expect(text).toContain('## PROJ-1 — Задача PROJ-1');
    expect(text).toContain(
      'Status: В работе · type: Story · updated: 2026-10-17T10:00:00.000+0000',
    );
    expect(text).toContain('Описание PROJ-1');
    expect(text).toContain('### Comments (20, last 15)');
    expect(text).not.toContain('комментарий 5\n');
    expect(text).toContain('комментарий 6');
    expect(text).toContain('комментарий 20');
    expect(text).toContain('- макет.png');
    expect(text).toContain('- blocks PROJ-2 — Импорт');
  });

  it('длинное описание обрезано с пометкой; сбой одной задачи назван с причиной, остальные прочитаны', async () => {
    const dir = copyDir();
    const result = await seedTaskTickets(
      dir,
      ['PROJ-1', 'PROJ-2'],
      source({
        'PROJ-1': issue('PROJ-1', { description: 'x'.repeat(7000) }),
        'PROJ-2': new Error('403 нет доступа'),
      }),
      AT,
    );

    expect(result).toEqual({ written: true, read: 1, failed: 1 });
    const text = fileOf(dir);
    expect(text).toContain('… (cut at 6000 chars — the rest is in the tracker)');
    expect(text).not.toContain('x'.repeat(6001));
    expect(text).toContain(
      '## PROJ-2\n\nNot read by the panel (403 нет доступа) — read it in the tracker.',
    );
  });

  it('больше восьми задач: восемь прочитаны, остальные названы для трекера', async () => {
    const dir = copyDir();
    const keys = Array.from({ length: 10 }, (_, i) => `PROJ-${i + 1}`);
    const all = source(Object.fromEntries(keys.map((key) => [key, issue(key)])));

    await seedTaskTickets(dir, keys, all, AT);

    expect(all.asked).toEqual(keys.slice(0, 8));
    expect(fileOf(dir)).toContain(
      'Not copied (over 8 tasks): PROJ-9, PROJ-10 — read them in the tracker.',
    );
  });

  it('повторный старт переписывает файл свежим чтением, временных файлов не остаётся', async () => {
    const dir = copyDir();
    await seedTaskTickets(
      dir,
      ['PROJ-1'],
      source({ 'PROJ-1': issue('PROJ-1', { status: 'Открыт' }) }),
      AT,
    );
    await seedTaskTickets(
      dir,
      ['PROJ-1'],
      source({ 'PROJ-1': issue('PROJ-1', { status: 'Готово' }) }),
      AT,
    );

    expect(fileOf(dir)).toContain('Status: Готово');
    expect(fileOf(dir)).not.toContain('Status: Открыт');
    expect(readdirSync(join(dir, '.agent', 'run')).sort()).toEqual(['.gitignore', 'tickets.md']);
  });

  it('нет ключей или трекер не подключён — файла нет и трекер не спрошен', async () => {
    const dir = copyDir();
    const off = source({ 'PROJ-1': issue('PROJ-1') }, false);

    expect(await seedTaskTickets(dir, [], source({}), AT)).toEqual({
      written: false,
      read: 0,
      failed: 0,
    });
    expect(await seedTaskTickets(dir, ['PROJ-1'], off, AT)).toEqual({
      written: false,
      read: 0,
      failed: 0,
    });
    expect(await seedTaskTickets(dir, ['PROJ-1'], undefined, AT)).toEqual({
      written: false,
      read: 0,
      failed: 0,
    });
    expect(off.asked).toEqual([]);
    expect(existsSync(join(dir, TASK_TICKETS))).toBe(false);
  });
});
