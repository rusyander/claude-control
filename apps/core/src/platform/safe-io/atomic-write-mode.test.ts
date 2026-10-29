import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic-write.ts';

const isWin = process.platform === 'win32';
const root = mkdtempSync(join(tmpdir(), 'atomic-mode-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('F-110 writeFileAtomic — a replace never widens the target mode', () => {
  it.runIf(!isWin)('F-110 an existing 0600 file stays 0600 when no mode is given', () => {
    const file = join(root, 'secret');
    writeFileSync(file, 'a', { mode: 0o600 });
    chmodSync(file, 0o600);
    writeFileAtomic(file, 'b');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.runIf(!isWin)(
    'F-110 an explicit mode wins; a new file without a mode is 0644 (minus umask)',
    () => {
      const fresh = join(root, 'fresh');
      writeFileAtomic(fresh, 'x');
      expect(statSync(fresh).mode & 0o077 & ~0o044).toBe(0);
      const explicit = join(root, 'explicit');
      writeFileSync(explicit, 'a', { mode: 0o600 });
      writeFileAtomic(explicit, 'b', { mode: 0o640 });
      expect(statSync(explicit).mode & 0o777).toBe(0o640 & ~process.umask());
    },
  );
});
