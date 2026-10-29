import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CORE_HOME_ENV, defaultCoreHome } from './core-home.ts';
import { powershellExe } from './run-tool.ts';
import { helperDllPath, runWinHelper } from './win-helper.ts';

const isWin = process.platform === 'win32';
const EVERYONE = '*S-1-1-0';
// Свой дом ядра на время файла: подложенная сборка не попадает в настоящий кэш пользователя.
const home = mkdtempSync(join(tmpdir(), 'win-helper-home-'));
beforeAll(() => {
  vi.stubEnv(CORE_HOME_ENV, home);
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('F-18 Windows helper DLL — cached only in the core home, loaded only when private', () => {
  it('F-18 the cached DLL lives under the core home, never in the shared temp directory', () => {
    const rel = relative(defaultCoreHome(), helperDllPath());
    expect(rel.startsWith('..') || isAbsolute(rel)).toBe(false);
  });

  it.runIf(isWin)(
    'F-18 a planted DLL whose ACL lets Everyone write is not loaded — the helper compiles its own',
    async () => {
      const dll = helperDllPath();
      mkdirSync(dirname(dll), { recursive: true });
      rmSync(dll, { force: true });
      const fake =
        'public static class AgentdeckCoreHelper {' +
        ' public static string Table() { return "4242 1 999" + (char)10; }' +
        ' public static string Kill(string p) { return "x"; }' +
        ' public static string Tcp() { return "x"; }' +
        ' public static string Environ(string w) { return "x"; } }';
      execFileSync(powershellExe(), [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -TypeDefinition '${fake.replace(/'/g, "''")}' -OutputAssembly '${dll.replace(/'/g, "''")}' -OutputType Library`,
      ]);
      expect(existsSync(dll)).toBe(true);
      execFileSync('icacls', [dll, '/grant', `${EVERYONE}:(M)`], { stdio: 'ignore' });
      const run = await runWinHelper('table');
      expect(run.ok).toBe(true);
      const out = run.ok ? run.stdout : '';
      expect(out.trim()).not.toBe('4242 1 999');
      // Строка своего процесса — с именем образа (A2-F02): node.exe этого прогона.
      expect(out).toMatch(new RegExp(`^${process.pid} \\d+ \\d+ node\\.exe$`, 'im'));
    },
    60_000,
  );
});
