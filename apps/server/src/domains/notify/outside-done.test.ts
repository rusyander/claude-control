import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunNotice } from '../chat/ChatRunRegistry/ChatRunRegistry.ts';
import { createOutsideDone } from './outside-done.ts';

/**
 * Сессия из терминала или VS Code кончила ход (хук `Stop`): сколько он шёл —
 * от последней реплики человека в транскрипте. «Закончил» уходит одним
 * уведомлением на ход; свой прогон панели сообщает о себе сам.
 */

const T0 = Date.parse('2026-10-25T10:00:00.000Z');

function transcript(dir: string, startedAt: number, extra: object[] = []): string {
  const path = join(dir, 's1.jsonl');
  const at = (ms: number) => new Date(ms).toISOString();
  const records = [
    {
      type: 'user',
      cwd: '/w/shop',
      timestamp: at(startedAt - 3_600_000),
      message: { role: 'user', content: 'старый ход' },
    },
    {
      type: 'assistant',
      cwd: '/w/shop',
      timestamp: at(startedAt - 3_500_000),
      message: { role: 'assistant', content: [{ type: 'text', text: 'ок' }] },
    },
    {
      type: 'user',
      cwd: '/w/shop',
      timestamp: at(startedAt),
      message: { role: 'user', content: 'Почини сборку' },
    },
    {
      type: 'assistant',
      cwd: '/w/shop/sub',
      timestamp: at(startedAt + 1000),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      },
    },
    {
      type: 'user',
      cwd: '/w/shop/sub',
      timestamp: at(startedAt + 2000),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    },
    ...extra,
  ];
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return path;
}

describe('«Закончил» у сессий вне панели', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('длительность — от последней реплики человека, проект — первый каталог; один раз на ход', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-outside-done-'));
    const path = transcript(dir, T0);
    const notices: RunNotice[] = [];
    const ended = createOutsideDone({
      transcriptOf: () => path,
      ownSession: () => false,
      notify: (notice) => notices.push(notice),
      now: () => T0 + 12 * 60_000,
    });
    ended('s1');
    ended('s1');
    expect(notices).toEqual([
      {
        kind: 'done',
        chatId: 's1',
        outside: true,
        projectPath: '/w/shop',
        durationMs: 12 * 60_000,
      },
    ]);
  });

  it('ход длиннее хвоста в 512 КБ — длительность всё равно от реплики человека', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-outside-done-'));
    // Два мегабайта вывода инструментов за ход: начало хода далеко за хвостом.
    const bulky = Array.from({ length: 40 }, (_, at) => ({
      type: 'user',
      cwd: '/w/shop',
      timestamp: new Date(T0 + 60_000 + at * 1_000).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `b${at}`, content: 'x'.repeat(50_000) }],
      },
    }));
    const path = transcript(dir, T0, bulky);
    const notices: RunNotice[] = [];
    const ended = createOutsideDone({
      transcriptOf: () => path,
      ownSession: () => false,
      notify: (notice) => notices.push(notice),
      now: () => T0 + 90 * 60_000,
    });
    ended('s1');
    expect(notices.map((notice) => notice.durationMs)).toEqual([90 * 60_000]);
  });

  it('новый ход той же сессии — снова; свой прогон панели и сессия без транскрипта — тишина', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-outside-done-'));
    let path = transcript(dir, T0);
    const notices: RunNotice[] = [];
    let own = false;
    let now = T0 + 60_000;
    const ended = createOutsideDone({
      transcriptOf: (id) => (id === 's1' ? path : undefined),
      ownSession: () => own,
      notify: (notice) => notices.push(notice),
      now: () => now,
    });
    ended('s1');
    path = transcript(dir, T0 + 30 * 60_000);
    now = T0 + 40 * 60_000;
    ended('s1');
    expect(notices.map((notice) => notice.durationMs)).toEqual([60_000, 10 * 60_000]);
    own = true;
    path = transcript(dir, T0 + 50 * 60_000);
    ended('s1');
    ended('nope');
    expect(notices).toHaveLength(2);
  });
});
