import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Неудача удаления в фоне не должна оставаться незамеченной.
 *
 * Внутри песочницы лежит копия `.credentials.json` и значения env MCP-серверов
 * открытым текстом. Подметание молча пропускало папку, которую не удалось
 * снести (файл держит ещё не умерший процесс CLI, EBUSY на Windows), — та же
 * тишина, против которой сделан честный отказ у `removeSandbox`. Убрать такую
 * папку может только человек, значит он должен о ней узнать.
 *
 * Отказ удаления подделываем на уровне safe-io: воспроизвести настоящий EBUSY
 * одинаково на всех системах нельзя, а проверяем мы поведение подметания.
 */
vi.mock('../../lib/safe-io.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/safe-io.ts')>()),
  removeEntry: vi.fn(() => {
    throw new Error('EBUSY: resource busy or locked');
  }),
}));

const {
  startSandboxHousekeeping,
  startSandboxSweeper,
  stopSandboxSweeper,
  sweepAbandonedSandboxes,
  sweepIdleSandboxes,
} = await import('./SandboxConfig.ts');

describe('подметание сообщает о неудачном удалении', () => {
  let root: string;
  let dir: string;
  const hour = 60 * 60 * 1000;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-sweep-fail-'));
    dir = join(root, 'qa-stuck');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', '.credentials.json'), '{"token":"пример"}');

    const old = new Date(Date.now() - 3 * hour);
    for (const path of [join(dir, 'config', '.credentials.json'), join(dir, 'config'), dir]) {
      utimesSync(path, old, old);
    }
  });

  afterEach(() => {
    stopSandboxSweeper();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('проход по простою возвращает отказ, а не пустой список удалённых', () => {
    const report = sweepIdleSandboxes(Date.now(), root, hour);

    expect(report.removed).toEqual([]);
    expect(report.failed).toEqual([
      { id: 'qa-stuck', path: dir, error: expect.stringContaining('EBUSY') },
    ]);
    expect(existsSync(dir)).toBe(true);
  });

  it('стартовый проход тоже не выдаёт неудачу за уборку', () => {
    const report = sweepAbandonedSandboxes(Date.now(), root);

    expect(report.removed).toEqual([]);
    expect(report.failed.map((item) => item.id)).toEqual(['qa-stuck']);
  });

  it('таймер подметания жалуется в назначенный сток, а не молчит', () => {
    vi.useFakeTimers();
    const lines: string[] = [];

    startSandboxSweeper({
      intervalMs: 1000,
      idleMs: hour,
      root,
      report: (line) => lines.push(line),
    });
    vi.advanceTimersByTime(1000);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(dir);
    expect(lines[0]).toContain('копия доступа');
  });

  it('уборка на старте называет папку, которую придётся убрать руками', () => {
    const lines: string[] = [];

    const report = startSandboxHousekeeping({
      root,
      now: Date.now(),
      idleMs: hour,
      report: (line) => lines.push(line),
    });

    expect(report.failed.map((item) => item.path)).toEqual([dir]);
    expect(lines[0]).toContain(dir);
  });
});
