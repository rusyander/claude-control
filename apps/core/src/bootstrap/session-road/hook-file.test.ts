import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cmdWrapperScript } from '../../platform/exec-bit.ts';
import { currentOs } from '../../platform/os-kind.ts';
import { HOOK_MODE, MCP_RUN } from '../../mcp/main.ts';
import { captureRoadsSignal } from './capture-roads.ts';
import { containerWrapperArgv, coreHookCommand } from './hook-file.ts';

/**
 * Текст обёрток движка (P58): `.cmd` для оболочки Windows и argv разбора в node ядра. Живой
 * прогон `.cmd` — тем `cmd`, что исполняет его у CLI: `%` в слове не раскрывается, метазнаки и
 * пробелы остаются внутри слова, хвост вызова доходит как есть, код выхода — код node.
 */

const root = mkdtempSync(join(tmpdir(), 'cmdwrap-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('container wrapper files (P58)', () => {
  it('cmd script: CRLF, plain words bare, words with spaces or metacharacters quoted, % doubled, tail %*', () => {
    expect(
      cmdWrapperScript(['C:\\n\\node.exe', 'a b', '50%x%', 'p&q', 'run.ts']).split('\r\n'),
    ).toEqual([
      '@echo off',
      'C:\\n\\node.exe "a b" "50%%x%%" "p&q" run.ts %*',
      'exit /b %ERRORLEVEL%',
      '',
    ]);
  });

  it('cmd script note: one rem line of the caller, never the container note in a capture wrapper; a line break cannot start a command', () => {
    expect(cmdWrapperScript(['go.exe'], 'checks ask the core\r\necho pwned').split('\r\n')).toEqual(
      [
        '@echo off',
        'rem agentdeck: checks ask the core echo pwned',
        'go.exe %*',
        'exit /b %ERRORLEVEL%',
        '',
      ],
    );
  });

  it('wrapper argv: node of the core, run.ts container mode, engine, task, real argv as one base64url word', () => {
    const argv = containerWrapperArgv(['node', '--flag'], 'docker', ['C:\\P F\\docker.exe'], 'T1');
    expect(argv.slice(0, 2)).toEqual(['node', '--flag']);
    expect(argv.slice(3, 6)).toEqual(['container', 'docker', 'T1']);
    const encoded = argv[6]!;
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual([
      'C:\\P F\\docker.exe',
    ]);
  });

  it('core hook on POSIX: the hook file cannot be written → refusal naming the cause, never a command without a hook (B2r6-F04)', () => {
    const blocker = join(root, 'not-a-dir');
    writeFileSync(blocker, 'a file where the session dir should be');
    const got = coreHookCommand(blocker, ['node'], 'linux');
    expect(got).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^core hook not installed: /),
    });
  });

  it('core hook on Windows: node with a space goes by its 8.3 name, every word but the last quoted', () => {
    const got = coreHookCommand(
      root,
      ['C:\\Program Files\\nodejs\\node.exe', '--x'],
      'win32',
      () => 'C:\\PROGRA~1\\nodejs\\node.exe',
    );
    expect(got).toEqual({
      ok: true,
      command: `"C:\\PROGRA~1\\nodejs\\node.exe" "--x" "${MCP_RUN}" ${HOOK_MODE}`,
    });
  });

  it('capture-roads signal: a found tool whose wrapper failed is warn and named NOT captured, not listed as absent (B2r6-F04)', () => {
    const got = captureRoadsSignal({
      tools: ['go'],
      failed: [{ tool: 'pytest', reason: 'EACCES: mode read back 644' }],
    });
    expect(got.severity).toBe('warn');
    expect(got.detail).toContain('path-wrapper: go');
    expect(got.detail).toContain(
      'NOT captured: pytest wrapper not installed (EACCES: mode read back 644)',
    );
    expect(got.detail).not.toMatch(/not on PATH \(no wrapper\): [^;]*pytest/);
    expect(captureRoadsSignal({ tools: ['go'], failed: [] }).severity).toBe('info');
  });

  it.runIf(currentOs() === 'win32')(
    'cmd executes the script: % kept literally, & and spaces stay inside the word, tail arguments and exit code pass through',
    () => {
      const file = join(root, 'w.cmd');
      const code =
        "process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exit(process.argv.includes('fail')?4:0)";
      writeFileSync(
        file,
        cmdWrapperScript([process.execPath, '-e', code, 'a b', '50%PATH%', 'x&y']),
      );
      const run = (tail: string) =>
        spawnSync(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${file} ${tail}"`], {
          encoding: 'utf8',
          windowsHide: true,
          windowsVerbatimArguments: true,
          timeout: 60_000,
        });
      const ok = run('tail1');
      expect(ok.status, ok.stderr).toBe(0);
      expect(JSON.parse(ok.stdout)).toEqual(['a b', '50%PATH%', 'x&y', 'tail1']);
      expect(run('fail').status).toBe(4);
    },
  );
});
