import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_EXIT_FILE } from '@agentdeck/contracts/core/supervisor';
import { readCoreExit } from './probe.ts';

const homes: string[] = [];
function homeWith(text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'core-exit-read-'));
  homes.push(dir);
  if (text !== undefined) writeFileSync(join(dir, CORE_EXIT_FILE), text, 'utf8');
  return dir;
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readCoreExit: the core’s own exit record', () => {
  it('same pid → code and signal as written', () => {
    const home = homeWith('{"pid":42,"code":1,"signal":null,"at":"2026-11-02T00:00:00Z"}');
    expect(readCoreExit(home, 42)).toEqual({ code: 1, signal: null });
    const stopped = homeWith('{"pid":7,"code":0,"signal":"SIGTERM","at":"x"}');
    expect(readCoreExit(stopped, 7)).toEqual({ code: 0, signal: 'SIGTERM' });
  });

  it('another pid, no file, broken JSON, or neither code nor signal → null', () => {
    expect(readCoreExit(homeWith('{"pid":41,"code":1,"signal":null}'), 42)).toBeNull();
    expect(readCoreExit(homeWith(), 42)).toBeNull();
    expect(readCoreExit(homeWith('{ broken'), 42)).toBeNull();
    expect(readCoreExit(homeWith('{"pid":42,"code":null,"signal":null}'), 42)).toBeNull();
    expect(readCoreExit(homeWith('null'), 42)).toBeNull();
  });
});
