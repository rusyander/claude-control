import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

/**
 * Ветка «не Windows» у списка процессов CLI — так, как её видит macOS. Живой
 * macOS здесь не запустить, поэтому подменена только внешняя граница: `ps`.
 * Подделка ведёт себя как BSD `ps` — ключевые слова из man-страницы macOS,
 * незнакомое слово (например, linux-овское `etimes`) — отказ с выходом 1, а
 * возраст печатается в формате `etime` (`[[дд-]чч:]мм:сс`). Код под проверкой —
 * настоящий `listCliProcesses` с `process.platform === 'darwin'`.
 */

const ID = 'f104fdda-599b-4973-a272-fe5a515c08b7';

/** Ключевые слова `-o` у `ps` macOS (man ps, раздел KEYWORDS) — без `etimes`. */
const BSD_KEYWORDS = new Set([
  'args',
  'comm',
  'command',
  'cpu',
  'etime',
  'flags',
  'gid',
  'lstart',
  'pgid',
  'pid',
  'ppid',
  'rss',
  'start',
  'state',
  'time',
  'tt',
  'uid',
  'user',
  'vsz',
  'wchan',
]);

const calls: string[][] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push([file, ...args]);
    if (file !== 'ps') {
      callback(new Error(`${file}: not found`));
      return;
    }
    const spec = args[args.findIndex((arg) => arg === '-eo' || arg === '-o') + 1] ?? '';
    const unknown = spec
      .split(',')
      .map((part) => part.replace(/=.*$/, ''))
      .find((keyword) => !BSD_KEYWORDS.has(keyword));
    if (unknown) {
      callback(Object.assign(new Error(`ps: ${unknown}: keyword not found`), { code: 1 }));
      return;
    }
    callback(null, {
      stdout: [
        `  4242     1    01:30 /usr/local/bin/node /usr/local/bin/claude --resume ${ID}`,
        `  4243     1 2-03:04:05 /usr/local/bin/claude --session-id ${ID}`,
        `  4244     1    00:05 vim notes.md`,
        '',
      ].join('\n'),
      stderr: '',
    });
  };
  return { ...real, execFile };
});

describe('listCliProcesses на macOS (BSD ps)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  beforeEach(() => {
    calls.length = 0;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterEach(() => {
    if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
    vi.useRealTimers();
  });

  it('находит CLI сессии и считает время создания из etime', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date'] });
    const { listCliProcesses } = await import('./session-process.ts');
    const rows = (await listCliProcesses()) ?? [];
    expect(calls[0]?.[0]).toBe('ps');
    expect(rows.map((row) => row.pid)).toEqual([4242, 4243]);
    expect(rows[0]?.startedAtMs).toBe(1_800_000_000_000 - 90_000);
    expect(rows[1]?.startedAtMs).toBe(
      1_800_000_000_000 - (2 * 86_400 + 3 * 3_600 + 4 * 60 + 5) * 1000,
    );
  });
});
