import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureExecBit, usableShortPath, windowsShortPath, writeExecutable } from './exec-bit.ts';
import { spawnResolved } from './spawn.ts';

const isWin = process.platform === 'win32';
let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'exec-bit-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runScript(file: string): Promise<{ code: number | null; out: string }> {
  const outcome = spawnResolved({
    command: file,
    args: [],
    cwd: dir,
    env: { PATH: '/usr/bin:/bin' },
  });
  if (!outcome.ok) return Promise.resolve({ code: -1, out: outcome.reason });
  let out = '';
  outcome.child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  return new Promise((done) => outcome.child.once('close', (code) => done({ code, out })));
}

describe('P105 exec bit — core-installed hooks and wrappers', () => {
  it.runIf(!isWin)('P105 written under umask 077 → still 0755 and it runs', async () => {
    const previous = process.umask(0o077);
    try {
      const hook = join(dir, 'hooks', 'pre-tool.sh');
      expect(writeExecutable(hook, '#!/bin/sh\necho hook-ran\n')).toEqual({
        ok: true,
        mode: 0o755,
      });
      expect(statSync(hook).mode & 0o777).toBe(0o755);
      expect(await runScript(hook)).toEqual({ code: 0, out: 'hook-ran\n' });
    } finally {
      process.umask(previous);
    }
  });

  it.runIf(!isWin)(
    'P105 a copy that lost the bit (0644) → not runnable; ensureExecBit → 0755 and runs',
    async () => {
      const wrapper = join(dir, 'wrapper.sh');
      writeFileSync(wrapper, '#!/bin/sh\necho wrapper-ran\n');
      chmodSync(wrapper, 0o644);
      expect((await runScript(wrapper)).code).toBe(-1);
      expect(ensureExecBit(wrapper)).toEqual({ ok: true, mode: 0o755 });
      expect(await runScript(wrapper)).toEqual({ code: 0, out: 'wrapper-ran\n' });
    },
  );

  it.runIf(!isWin)('P105 missing file → refusal with a reason, not «installed»', () => {
    const outcome = ensureExecBit(join(dir, 'absent.sh'));
    expect(outcome.ok).toBe(false);
    expect('reason' in outcome ? outcome.reason : '').toMatch(/^ENOENT/);
  });

  it.runIf(isWin)('P105 Windows → written, exec bit not applicable (named)', () => {
    const file = join(dir, 'hook.cmd');
    expect(writeExecutable(file, '@echo off\r\n')).toEqual({
      ok: true,
      notApplicable: 'Windows: no exec bit, the extension decides',
    });
  });
});

describe.skipIf(!isWin)('Windows short path for hook command words', () => {
  it('a path with spaces and an apostrophe gives a space-free 8.3 name of the same file; a missing path gives none', () => {
    const spaced = join(dir, "dir with space's");
    mkdirSync(spaced, { recursive: true });
    const file = join(spaced, 'probe file.txt');
    writeFileSync(file, 'same file');
    const short = windowsShortPath(file);
    expect(short).not.toBeNull();
    expect(short).not.toMatch(/\s/);
    expect(readFileSync(short!, 'utf8')).toBe('same file');
    expect(windowsShortPath(join(spaced, 'absent file.txt'))).toBeNull();
  });
});

describe('short path answer check', () => {
  it('an existing space-free path (trimmed) is taken; a path with a space (8.3 off on the volume), a missing one or nothing → null', () => {
    const plain = join(dir, 'plain');
    const spaced = join(dir, 'still spaced');
    mkdirSync(plain, { recursive: true });
    mkdirSync(spaced, { recursive: true });
    expect(usableShortPath(`${plain}\r\n`)).toBe(plain);
    expect(usableShortPath(spaced)).toBeNull();
    expect(usableShortPath(join(dir, 'absent'))).toBeNull();
    expect(usableShortPath('  \n')).toBeNull();
  });
});
