import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeToolOutput, gitBaseArgs, parseOemCodePage } from './encoding.ts';
import { consoleCodePage, runTool } from './run-tool.ts';
import {
  LOW_OPEN_FILES,
  openFilesLimit,
  parseLaunchctlMaxfiles,
  parseProcLimits,
} from './limits.ts';
import { hasValue } from './os-kind.ts';

const isWin = process.platform === 'win32';
let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'enc-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('P22 tool output encoding and git names verbatim', () => {
  it('P22 bytes: UTF-8 kept, cp866 console bytes decoded by the OEM page, unknown page → latin1 (bytes kept)', () => {
    const cp866 = Uint8Array.from([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2]);
    expect(decodeToolOutput(cp866, 866)).toBe('Привет');
    expect(decodeToolOutput(Buffer.from('Привет ü', 'utf8'), 866)).toBe('Привет ü');
    expect(decodeToolOutput(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    expect(decodeToolOutput(cp866, 437)).toBe(Buffer.from(cp866).toString('latin1'));
    expect(parseOemCodePage('    OEMCP    REG_SZ    866\r\n')).toBe(866);
  });

  it.runIf(isWin)(
    'P22 Windows console page read from the registry is a real code page',
    async () => {
      expect(await consoleCodePage()).toBeGreaterThan(0);
    },
  );

  it('P22 git with the core base args reports a Cyrillic file name verbatim (quoted octal without them)', async () => {
    const repo = join(dir, 'repo');
    const init = await runTool('git', ['init', '-q', repo]);
    expect(init.ok).toBe(true);
    writeFileSync(join(repo, 'файл.txt'), 'x');
    const plain = await runTool('git', [
      '-C',
      repo,
      '-c',
      'core.quotepath=on',
      'status',
      '--porcelain',
    ]);
    const ours = await runTool('git', ['-C', repo, ...gitBaseArgs(), 'status', '--porcelain']);
    expect(plain.ok && plain.stdout).toContain('\\321\\204');
    expect(ours.ok && ours.stdout.trim()).toBe('?? файл.txt');
    expect(gitBaseArgs('win32')).toEqual(['-c', 'core.quotepath=off', '-c', 'core.longpaths=true']);
    expect(gitBaseArgs('linux')).toEqual(['-c', 'core.quotepath=off']);
  });
});

describe('limits — open files read at boot, warn under 4096', () => {
  it('limits: recorded /proc/self/limits and launchctl output parsed; 256 → low', () => {
    const proc =
      'Limit                     Soft Limit           Hard Limit           Units     \n' +
      'Max cpu time              unlimited            unlimited            seconds   \n' +
      'Max open files            1024                 1048576              files     \n';
    expect(parseProcLimits(proc)).toEqual({
      soft: 1024,
      hard: 1048576,
      low: true,
      source: 'proc-self-limits',
    });
    expect(parseLaunchctlMaxfiles('\tmaxfiles    256            unlimited      \n')).toEqual({
      soft: 256,
      hard: 'unlimited',
      low: true,
      source: 'launchctl',
    });
    expect(parseLaunchctlMaxfiles('\tmaxfiles    65536          unlimited\n')?.low).toBe(false);
    expect(parseProcLimits('garbage')).toBeUndefined();
    expect(LOW_OPEN_FILES).toBe(4096);
  });

  it('limits: macOS reader turns a failed launchctl into unknown, never a number', async () => {
    const failed = await openFilesLimit('darwin', async () => ({
      ok: false,
      reason: 'ENOENT',
      timedOut: false,
    }));
    expect(failed).toEqual({ unknown: 'launchctl: ENOENT' });
    const read = await openFilesLimit('darwin', async () => ({
      ok: true,
      code: 0,
      stdout: '\tmaxfiles    256            unlimited\n',
      stderr: '',
      timedOut: false,
    }));
    expect(read).toEqual({
      value: { soft: 256, hard: 'unlimited', low: true, source: 'launchctl' },
    });
  });

  it('limits: this OS → Linux reads its own limit, Windows not applicable', async () => {
    const got = await openFilesLimit();
    if (isWin)
      expect(got).toEqual({ notApplicable: 'Windows: no per-process soft open-file limit' });
    else if (process.platform === 'linux')
      expect('value' in got && hasValue(got) ? got.value.source : '').toBe('proc-self-limits');
  });
});
