import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JiraIssueBrief } from '../../integrations/atlassian/jira.ts';
import { RUN_DIR } from '../../../lib/run-dir/run-dir.ts';
import {
  TASK_TICKETS,
  TASK_TICKETS_STANDING,
  readTaskTickets,
  recheckTickets,
  seedTaskTickets,
} from './task-tickets.ts';
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

    expect(result).toMatchObject({ written: true, read: 1, failed: 0 });
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

    expect(result).toMatchObject({ written: true, read: 1, failed: 1 });
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

  it('файл задач лежит в каталоге запуска копии — его же читает проверка доставки', () => {
    expect(TASK_TICKETS.startsWith(`${RUN_DIR}/`)).toBe(true);
    expect(readTaskTickets(copyDir())).toBeUndefined();
  });
});

/**
 * «Перепроверить MR» (аудит g0 26.10, F3): задание требовало прочесть девять тикетов через
 * MCP, группа не прочла ни одного. Панель перечитывает их в копию сама и делит на
 * изменённые после последней доставки и прежние — по `updated` Jira со смещением `+0300`.
 */
describe('task-tickets: перечитать задачи к перепроверке MR (g0 F3)', () => {
  it('изменённые после доставки, прежние и непрочитанные — раздельно; файл в копии свежий', async () => {
    const dir = copyDir();
    const result = await recheckTickets(
      dir,
      ['PROJ-1', 'PROJ-2', 'PROJ-3'],
      source({
        // 18:09 по +0300 = 15:09Z — позже доставки в 15:00Z.
        'PROJ-1': issue('PROJ-1', { updatedAt: '2026-10-26T18:09:25.123+0300' }),
        // 17:59 по +0300 = 14:59Z — раньше доставки: без смещения было бы «изменена».
        'PROJ-2': issue('PROJ-2', { updatedAt: '2026-10-26T17:59:00.000+0300' }),
        'PROJ-3': new Error('403 нет доступа'),
      }),
      '2026-10-26T15:00:00.000Z',
      AT,
    );

    expect(result).toEqual({
      at: '2026-10-17T12:00:00.000Z',
      since: '2026-10-26T15:00:00.000Z',
      changed: [{ key: 'PROJ-1', updatedAt: '2026-10-26T18:09:25.123+0300' }],
      unchanged: ['PROJ-2'],
      unread: ['PROJ-3 — 403 нет доступа'],
    });
    expect(readTaskTickets(dir)).toContain('## PROJ-1 — Задача PROJ-1');
  });

  /**
   * Аудит g9 27.10 (R6): задание просило не перечитывать прежние задачи, а группа прочла
   * весь файл — 11k при контексте 201k. Прежняя задача в файле — указатель, её текст —
   * в соседнем файле; проверка доставки читает оба (цитата пункта прежней задачи находится).
   */
  it('прежняя задача — указатель в файле задач, полный текст рядом; проверка доставки видит оба', async () => {
    const dir = copyDir();
    const read = () =>
      source({
        'PROJ-1': issue('PROJ-1', { updatedAt: '2026-10-26T18:09:25.123+0300' }),
        'PROJ-2': issue('PROJ-2', {
          updatedAt: '2026-10-26T17:59:00.000+0300',
          description: 'Кнопка «Сохранить» недоступна без прав',
        }),
      });
    await recheckTickets(dir, ['PROJ-1', 'PROJ-2'], read(), '2026-10-26T15:00:00.000Z', AT);

    const main = fileOf(dir);
    expect(main).toContain('Описание PROJ-1');
    expect(main).toMatch(
      /## PROJ-2 — Задача PROJ-2\n\nNot updated in the tracker since the last delivery \(2026-10-26T15:00:00\.000Z\)/u,
    );
    expect(main).toContain(`\`${TASK_TICKETS_STANDING}\``);
    expect(main).not.toContain('Кнопка «Сохранить» недоступна без прав');
    const standing = readFileSync(join(dir, TASK_TICKETS_STANDING), 'utf8');
    expect(standing).toContain('Кнопка «Сохранить» недоступна без прав');
    expect(standing).not.toContain('Описание PROJ-1');
    expect(readTaskTickets(dir)).toContain('Кнопка «Сохранить» недоступна без прав');

    // Старт группы (не перепроверка) пишет всё в файл задач, а файл прежних не оставляет.
    await seedTaskTickets(dir, ['PROJ-1', 'PROJ-2'], read(), AT);
    expect(fileOf(dir)).toContain('Кнопка «Сохранить» недоступна без прав');
    expect(existsSync(join(dir, TASK_TICKETS_STANDING))).toBe(false);
  });

  it('доставки не было — все задачи «изменены»; трекера нет — undefined, файла нет', async () => {
    const dir = copyDir();
    const all = await recheckTickets(
      dir,
      ['PROJ-1'],
      source({ 'PROJ-1': issue('PROJ-1') }),
      undefined,
      AT,
    );
    expect(all?.changed.map((item) => item.key)).toEqual(['PROJ-1']);
    expect(all?.unchanged).toEqual([]);

    const empty = copyDir();
    expect(
      await recheckTickets(empty, ['PROJ-1'], source({}, false), '2026-10-26T15:00:00.000Z', AT),
    ).toBeUndefined();
    expect(readTaskTickets(empty)).toBeUndefined();
  });

  /**
   * Аудит g5 27.10 (H1): задание говорило «пункты прежних задач стоят как сданы», а сданы были
   * 7 строк на 37 пунктов — PDF из комментария владельца не попал никуда. Прежняя задача стоит,
   * только когда каждый её пункт цитирует строка `task-N`; иначе она «должна» с пунктами
   * дословно и полным разделом в файле задач.
   */
  it('прежняя задача с непокрытым пунктом — owed с пунктом и полный раздел; покрыта — указатель', async () => {
    const read = () =>
      source({
        'PROJ-2': issue('PROJ-2', {
          updatedAt: '2026-10-26T17:59:00.000+0300',
          description: '* Фильтр журнала принимает диапазон дат\n* Нужен PDF отчёт для дизайна',
        }),
      });
    const quoted = {
      id: 'task-1',
      status: 'pass' as const,
      evidence: '«Фильтр журнала принимает диапазон дат»',
    };

    const dir = copyDir();
    const owing = await recheckTickets(dir, ['PROJ-2'], read(), '2026-10-26T15:00:00.000Z', AT, [
      quoted,
    ]);
    expect(owing).toMatchObject({
      changed: [],
      unchanged: [],
      owed: [{ key: 'PROJ-2', points: ['Нужен PDF отчёт для дизайна'] }],
    });
    expect(fileOf(dir)).toContain('Нужен PDF отчёт для дизайна');

    const covered = copyDir();
    const standing = await recheckTickets(
      covered,
      ['PROJ-2'],
      read(),
      '2026-10-26T15:00:00.000Z',
      AT,
      [
        quoted,
        { id: 'task-2', status: 'n/a', evidence: '«Нужен PDF отчёт для дизайна» — не в MR' },
      ],
    );
    expect(standing?.unchanged).toEqual(['PROJ-2']);
    expect(standing?.owed).toBeUndefined();
    expect(fileOf(covered)).not.toContain('Нужен PDF отчёт для дизайна');

    // Следа задач нет — пункты судить не по чему: задача стоит, как до H1.
    const bare = await recheckTickets(
      copyDir(),
      ['PROJ-2'],
      read(),
      '2026-10-26T15:00:00.000Z',
      AT,
    );
    expect(bare?.unchanged).toEqual(['PROJ-2']);
  });
});
