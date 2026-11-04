import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_EXIT_FILE } from '@agentdeck/contracts/core/supervisor';
import { recordExit } from './exit-record.ts';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');
const homes: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'core-exit-'));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('core exit record (core.exit.json)', () => {
  it('a core that dies on boot (unreadable config) leaves its own pid and code 1', () => {
    const dir = home();
    writeFileSync(join(dir, 'config.json'), '{ broken', 'utf8');
    const env = { ...process.env };
    delete env.VITEST;
    const run = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', ENTRY, '--home', dir],
      { cwd: join(dirname(ENTRY), '..'), env, encoding: 'utf8', timeout: 60_000 },
    );
    expect(run.status).toBe(1);
    const record = JSON.parse(readFileSync(join(dir, CORE_EXIT_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(record.pid).toBe(run.pid);
    expect(record.code).toBe(1);
    expect(record.signal).toBeNull();
    expect(Number.isNaN(Date.parse(String(record.at)))).toBe(false);
  });

  it('a signal noted before exit is written beside the code', () => {
    const dir = home();
    let handler: ((code: number) => void) | undefined;
    const written: Array<[string, string]> = [];
    const recorder = recordExit(dir, {
      pid: 77,
      now: () => new Date('2026-11-02T00:00:00.000Z'),
      onExit: (h) => {
        handler = h;
      },
      write: (file, text) => written.push([file, text]),
    });
    recorder.noteSignal('SIGTERM');
    handler?.(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.[0]).toBe(join(dir, CORE_EXIT_FILE));
    expect(JSON.parse(written[0]?.[1] ?? '')).toEqual({
      pid: 77,
      code: 0,
      signal: 'SIGTERM',
      at: '2026-11-02T00:00:00.000Z',
    });
  });

  it('an unwritable home does not throw out of the exit handler', () => {
    let handler: ((code: number) => void) | undefined;
    recordExit(home(), {
      onExit: (h) => {
        handler = h;
      },
      write: () => {
        throw new Error('EACCES');
      },
    });
    expect(() => handler?.(1)).not.toThrow();
  });
});
