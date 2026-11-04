import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunNotice } from './run-notice.types.ts';
import { createOutsideDone, OUTSIDE_SETTLE_MS } from './outside-done.ts';

/**
 * Сессия из терминала или VS Code кончила ход (хук `Stop`): через паузу суд по
 * транскрипту — сколько шёл ход (от последней реплики человека до записи конца),
 * итог хода и признаки того, что работа пошла дальше. Один конец — одно
 * уведомление; свой прогон панели сообщает о себе сам.
 */

const T0 = Date.parse('2026-10-25T10:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();

const closing = (ms: number, text: string, uuid = `end-${ms}`) => ({
  type: 'assistant',
  uuid,
  cwd: '/w/shop/sub',
  timestamp: at(ms),
  message: {
    id: `msg-${ms}`,
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
  },
});

function transcript(dir: string, startedAt: number, extra: object[] = [], end?: object): string {
  const path = join(dir, 's1.jsonl');
  const records = [
    {
      type: 'user',
      cwd: '/w/shop',
      timestamp: at(startedAt - 3_600_000),
      message: { role: 'user', content: 'старый ход' },
    },
    closing(startedAt - 3_500_000, 'ок'),
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
        id: 'msg-tool',
        role: 'assistant',
        stop_reason: 'tool_use',
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
    ...(end === undefined
      ? [closing(startedAt + 12 * 60_000, 'Задача закрыта: сборка снова зелёная.')]
      : [end]),
  ];
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return path;
}

/** Отложенные суды по очереди — тест сам решает, когда пауза кончилась. */
function clock() {
  const queued: { run: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    queued,
    schedule: (run: () => void, ms: number) => {
      const entry = { run, ms, cancelled: false };
      queued.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    flush: () => {
      for (const entry of queued.splice(0)) if (!entry.cancelled) entry.run();
    },
  };
}

describe('Конец хода у сессий вне панели', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('длительность — от последней реплики человека до конца хода, проект — первый каталог, итог хода; один раз на конец', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-outside-done-'));
    const path = transcript(dir, T0);
    const notices: RunNotice[] = [];
    const timer = clock();
    const ended = createOutsideDone({
      transcriptOf: () => path,
      ownSession: () => false,
      notify: (notice) => notices.push(notice),
      now: () => T0 + 13 * 60_000,
      schedule: timer.schedule,
    });
    ended('s1');
    expect(timer.queued.map((entry) => entry.ms)).toEqual([OUTSIDE_SETTLE_MS]);
    expect(notices).toEqual([]);
    timer.flush();
    ended('s1');
    timer.flush();
    expect(notices).toEqual([
      {
        kind: 'done',
        chatId: 's1',
        outside: true,
        projectPath: '/w/shop',
        durationMs: 12 * 60_000,
        answer: 'Задача закрыта: сборка снова зелёная.',
        turnKey: String(T0),
      },
    ]);
  });

  it('новый сигнал той же сессии переносит суд: судится один раз, по последнему', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-outside-done-'));
    const path = transcript(dir, T0);
    const notices: RunNotice[] = [];
    const timer = clock();
    const ended = createOutsideDone({
      transcriptOf: () => path,
      ownSession: () => false,
      notify: (notice) => notices.push(notice),
      schedule: timer.schedule,
    });
    ended('s1');
    ended('s1');
    expect(timer.queued.map((entry) => entry.cancelled)).toEqual([true, false]);
    timer.flush();
    expect(notices).toHaveLength(1);
  });

  it('хук Stop отбил конец — молчание до настоящего конца; ход ещё идёт — молчание', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-outside-done-'));
    const blocked = {
      type: 'system',
      subtype: 'stop_hook_summary',
      timestamp: at(T0 + 12 * 60_000 + 10),
      hookErrors: ['гейт не запускался'],
    };
    const nextTool = {
      type: 'assistant',
      cwd: '/w/shop',
      timestamp: at(T0 + 13 * 60_000),
      message: {
        id: 'msg-next',
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }],
      },
    };
    const early = closing(T0 + 12 * 60_000, 'Задача закрыта.', 'blocked-end');
    let path = transcript(dir, T0, [early], blocked);
    const notices: RunNotice[] = [];
    const timer = clock();
    const ended = createOutsideDone({
      transcriptOf: () => path,
      ownSession: () => false,
      notify: (notice) => notices.push(notice),
      schedule: timer.schedule,
    });
    ended('s1');
    timer.flush();
    path = transcript(dir, T0, [early, blocked], nextTool);
    ended('s1');
    timer.flush();
    expect(notices).toEqual([]);
    const result = {
      type: 'user',
      cwd: '/w/shop',
      timestamp: at(T0 + 14 * 60_000),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }],
      },
    };
    path = transcript(
      dir,
      T0,
      [early, blocked, nextTool, result],
      closing(T0 + 20 * 60_000, 'Задача закрыта: гейт зелёный.', 'final-end'),
    );
    ended('s1');
    timer.flush();
    expect(notices.map((notice) => [notice.answer, notice.durationMs])).toEqual([
      ['Задача закрыта: гейт зелёный.', 20 * 60_000],
    ]);
  });

  it('ход длиннее хвоста в 512 КБ — длительность всё равно от реплики человека', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-outside-done-'));
    // Два мегабайта вывода инструментов за ход: начало хода далеко за хвостом.
    const bulky = Array.from({ length: 40 }, (_, index) => ({
      type: 'user',
      cwd: '/w/shop',
      timestamp: at(T0 + 60_000 + index * 1_000),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `b${index}`, content: 'x'.repeat(50_000) }],
      },
    }));
    const path = transcript(dir, T0, bulky, closing(T0 + 90 * 60_000, 'Задача закрыта.'));
    const notices: RunNotice[] = [];
    const timer = clock();
    createOutsideDone({
      transcriptOf: () => path,
      ownSession: () => false,
      notify: (notice) => notices.push(notice),
      schedule: timer.schedule,
    })('s1');
    timer.flush();
    expect(notices.map((notice) => notice.durationMs)).toEqual([90 * 60_000]);
  });

  it('новый ход той же сессии — снова; свой прогон панели и сессия без транскрипта — тишина', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-outside-done-'));
    let path = transcript(dir, T0, [], closing(T0 + 60_000, 'Задача закрыта.'));
    const notices: RunNotice[] = [];
    let own = false;
    const timer = clock();
    const ended = createOutsideDone({
      transcriptOf: (id) => (id === 's1' ? path : undefined),
      ownSession: (id) => own && id === 's1',
      notify: (notice) => notices.push(notice),
      schedule: timer.schedule,
    });
    ended('s1');
    timer.flush();
    path = transcript(dir, T0 + 30 * 60_000, [], closing(T0 + 40 * 60_000, 'Задача закрыта.'));
    ended('s1');
    timer.flush();
    expect(notices.map((notice) => notice.durationMs)).toEqual([60_000, 10 * 60_000]);
    own = true;
    path = transcript(dir, T0 + 50 * 60_000);
    ended('s1');
    ended('nope');
    // Свой прогон не ставит суда вовсе; чужая сессия без транскрипта — ставит и молчит.
    expect(timer.queued).toHaveLength(1);
    timer.flush();
    expect(notices).toHaveLength(2);
  });
});
