import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CUSTOM_CMD, npmCmdShim } from '../../platform/__fixtures__/shims.ts';
import { waitFor } from '../../platform/__fixtures__/harness.ts';
import { stopTree } from '../../platform/tree-stop.ts';
import { sessionFile, type Identity } from '../../session-host/protocol.ts';
import { composeEnv, gitConfigEnv, joinNodeOptions } from './env.ts';
import { launchCli } from './launch.ts';
import { readArtifact, readLines, runOnce, stopSession } from './session-io.ts';
import type { CoreSessionVars, LaunchInput } from './launcher.types.ts';

const isWin = process.platform === 'win32';
const CLI = fileURLToPath(new URL('./__fixtures__/session-cli.mjs', import.meta.url));
const NASTY = [
  'plain',
  'with space',
  'quote "inner" end',
  'line1\nline2',
  '%PATH%',
  '$HOME and ${HOME}',
  'trailing back\\',
  '',
  'кириллица ü 漢字',
  '&|<>^!',
  "it's",
];
const CORE: CoreSessionVars = {
  taskId: 't-1',
  stepId: 's-2',
  stepKind: 'implement',
  coreUrl: 'http://127.0.0.1:1',
  sessionToken: 'session-access-value',
  state: { owned: ['src/a.ts'] },
};
const PLANTED = 'AGENTDECK_LAUNCHER_PLANTED';

let root = '';
let binDir = '';
const stopLater: Identity[] = [];
let seq = 0;

interface Dump {
  pid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  preloaded: string | null;
}

function pin(extra: Record<string, string> = {}): Record<string, string> {
  const keep = isWin ? ['SystemRoot', 'WINDIR'] : ['HOME'];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH = [binDir, dirname(process.execPath)].join(delimiter);
  return { ...env, ...extra };
}

function input(over: Partial<LaunchInput> = {}): LaunchInput {
  seq += 1;
  return {
    dir: join(root, 'sessions', `s${seq}`),
    sessionId: `launcher-${process.pid}-${seq}`,
    command: 'fake',
    args: [],
    cwd: root,
    env: { pin: pin() },
    core: CORE,
    ...over,
  };
}

async function linesUntilExit(dir: string, want = 1): Promise<string[]> {
  return waitFor(
    () => {
      const lines = readLines(dir, 'stdout', 0).lines;
      return existsSync(sessionFile(dir, 'exit')) || lines.length >= want + 1 ? lines : undefined;
    },
    30_000,
    'session output',
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  // Пробел и не-латиница в каждом звене: temp, каталог обёрток, cwd.
  root = mkdtempSync(join(tmpdir(), 'launcher тест ü '));
  binDir = join(root, 'bin dir');
  const pkg = join(binDir, 'node_modules', 'fake-cli');
  mkdirSync(pkg, { recursive: true });
  copyFileSync(CLI, join(pkg, 'cli.mjs'));
  if (isWin) {
    writeFileSync(join(binDir, 'fake.cmd'), npmCmdShim('node_modules\\fake-cli\\cli.mjs'));
    writeFileSync(join(binDir, 'custom.cmd'), CUSTOM_CMD);
  } else {
    const script = join(binDir, 'fake');
    writeFileSync(script, readFileSync(CLI, 'utf8'));
    chmodSync(script, 0o755);
  }
  process.env[PLANTED] = 'leaked-from-core';
});

afterAll(async () => {
  delete process.env[PLANTED];
  for (const id of stopLater) await stopTree(id, { graceMs: 500 });
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('launcher — P25 every spawn through the session host', () => {
  it('P25 npm shim (Windows) / shebang (POSIX) resolved before the host; argv with quotes, newlines, %, $ intact; journaled argv = what the OS ran', async () => {
    // CLI живёт 2 с: личность (номер + старт) читается у живого процесса.
    const run = await launchCli(
      input({ args: NASTY, env: { pin: pin(), session: { EXIT_AFTER_MS: '2000' } } }),
    );
    if (!run.ok) throw new Error(run.reason);
    stopLater.push(run.child);
    const [first] = await linesUntilExit(run.dir);
    const dump = JSON.parse(first ?? '{}') as Dump;
    expect(dump.argv).toEqual(NASTY);
    expect(run.spawned.kind).toBe(isWin ? 'shim-node' : 'shebang');
    // Журнал называет настоящий файл и полный argv, а не имя команды.
    expect(run.spawned.argv.slice(-NASTY.length)).toEqual(NASTY);
    if (isWin) expect(run.spawned.file.toLowerCase()).toMatch(/node\.exe$/);
    // Личность CLI — настоящий номер процесса, который напечатал строку.
    expect(run.child.pid).toBe(dump.pid);
    expect(run.child.start).not.toBe('');
  });

  it('P25 cwd given in short / unnormalised form → the CLI runs in the long-form realpath', async () => {
    const odd = join(root, '.', 'cwd dir');
    mkdirSync(odd, { recursive: true });
    const run = await launchCli(input({ cwd: odd }));
    if (!run.ok) throw new Error(run.reason);
    const dump = JSON.parse((await linesUntilExit(run.dir))[0] ?? '{}') as Dump;
    expect(dump.cwd).toBe(realpathSync.native(odd));
    expect(run.spawned.cwd).toBe(realpathSync.native(odd));
  });

  it('P25 pinned env: nothing inherited from the core process; session beats pin, core beats session; core vars + per-session TMPDIR + state file', async () => {
    const run = await launchCli(
      input({
        env: {
          pin: pin({ LAYER: 'pin', PIN_ONLY: '1' }),
          session: { LAYER: 'session', AGENTDECK_TASK: 'forged-by-session' },
        },
      }),
    );
    if (!run.ok) throw new Error(run.reason);
    const dump = JSON.parse((await linesUntilExit(run.dir))[0] ?? '{}') as Dump;
    expect(dump.env[PLANTED]).toBeUndefined();
    expect(dump.env.LAYER).toBe('session');
    expect(dump.env.PIN_ONLY).toBe('1');
    expect(dump.env.AGENTDECK_TASK).toBe('t-1');
    expect(dump.env.AGENTDECK_STEP).toBe('s-2');
    expect(dump.env.AGENTDECK_STEP_KIND).toBe('implement');
    expect(dump.env.AGENTDECK_CORE_URL).toBe(CORE.coreUrl);
    expect(dump.env.AGENTDECK_SESSION_TOKEN).toBe(CORE.sessionToken);
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) expect(dump.env[name]).toBe(run.tmpDir);
    expect(existsSync(run.tmpDir)).toBe(true);
    const state = JSON.parse(readFileSync(dump.env.AGENTDECK_STATE ?? '', 'utf8')) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({ task: 't-1', step: 's-2', owned: ['src/a.ts'] });
    // Журнал получает имена, а не значения (там токен сессии и ключи маршрута).
    expect(run.spawned.envNames).toContain('AGENTDECK_SESSION_TOKEN');
    expect(JSON.stringify(run.spawned)).not.toContain(CORE.sessionToken);
  });

  it.runIf(isWin)(
    'P25 Windows: `Path` of the pin and `PATH` of the session are one variable — the session wins, the CLI gets one PATH',
    () => {
      const env = composeEnv(
        { pin: { Path: 'C:\\pin', SystemRoot: 'C:\\Windows' }, session: { PATH: 'C:\\session' } },
        {},
      );
      const names = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
      expect(names).toEqual(['PATH']);
      expect(env.PATH).toBe('C:\\session');
    },
  );

  it('P25 NODE_OPTIONS: pin flags kept, core --require from a path with spaces quoted → preload runs in the CLI', async () => {
    const preload = join(root, 'core home', 'pre load.cjs');
    mkdirSync(dirname(preload), { recursive: true });
    writeFileSync(preload, "globalThis.__preloaded = 'yes';\n");
    const run = await launchCli(
      input({
        env: { pin: pin({ NODE_OPTIONS: '--max-old-space-size=512' }), nodeRequires: [preload] },
      }),
    );
    if (!run.ok) throw new Error(run.reason);
    const dump = JSON.parse((await linesUntilExit(run.dir))[0] ?? '{}') as Dump;
    expect(dump.preloaded).toBe('yes');
    expect(dump.env.NODE_OPTIONS).toMatch(/^--require "[^"]+" --max-old-space-size=512$/);
    expect(joinNodeOptions([undefined, ' '], [])).toBe('');
  });

  it('G22 NODE_OPTIONS: the core capture shim goes FIRST, a stale shim of another copy in the pin is dropped, foreign preloads kept after it', () => {
    const got = joinNodeOptions(
      ['--require "C:\\\\old copy\\\\capture-preload.cjs" -r ./journal.cjs', '--inspect'],
      ['/core/platform/capture-preload.cjs'],
    );
    expect(got).toBe('--require "/core/platform/capture-preload.cjs" -r ./journal.cjs --inspect');
  });

  it('P25 git under the session env: core git config (longpaths on Windows, quotepath) appended after the pin pairs and seen by a real git', async () => {
    const env = gitConfigEnv({ GIT_CONFIG_COUNT: '1' }, [
      '-c',
      'core.quotepath=off',
      '-c',
      'core.longpaths=true',
    ]);
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_1: 'core.quotepath',
      GIT_CONFIG_VALUE_1: 'off',
      GIT_CONFIG_KEY_2: 'core.longpaths',
      GIT_CONFIG_VALUE_2: 'true',
    });
    const composed = composeEnv(
      {
        pin: {
          ...pin(),
          ...gitPathPin(),
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'user.name',
          GIT_CONFIG_VALUE_0: 'Pin',
        },
      },
      {},
    );
    const quote = await runOnce('git', ['config', '--get', 'core.quotepath'], composed, root);
    expect(quote.stdout.trim()).toBe('off');
    const user = await runOnce('git', ['config', '--get', 'user.name'], composed, root);
    expect(user.stdout.trim()).toBe('Pin');
    const longpaths = await runOnce('git', ['config', '--get', 'core.longpaths'], composed, root);
    expect(longpaths.stdout.trim()).toBe(isWin ? 'true' : '');
  });

  it('F-95 a non-decimal GIT_CONFIG_COUNT (1e1, 0x2, 2.0) is not a count: core pairs start at 0', () => {
    for (const raw of ['1e1', '0x2', '2.0', '-1', '']) {
      const env = gitConfigEnv({ GIT_CONFIG_COUNT: raw }, ['-c', 'core.quotepath=off']);
      expect(env).toEqual({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.quotepath',
        GIT_CONFIG_VALUE_0: 'off',
      });
    }
    expect(gitConfigEnv({ GIT_CONFIG_COUNT: ' 2 ' }, []).GIT_CONFIG_COUNT).toBe('2');
  });

  it('F-45 spec 05 push closure in the session env: no prompt, no credential helper, ssh refuses receive-pack (real git)', async () => {
    const composed = composeEnv({ pin: { ...pin(), ...gitPathPin() } }, {});
    expect(composed.GIT_TERMINAL_PROMPT).toBe('0');
    const helpers = await runOnce(
      'git',
      ['config', '--get-all', 'credential.helper'],
      composed,
      root,
    );
    // Пустое значение сбрасывает список помощников: последняя запись — пустая.
    expect(helpers.stdout.split(/\r?\n/).slice(0, -1).pop()).toBe('');
    const repo = mkdtempSync(join(root, 'f45-'));
    await runOnce('git', ['init', '-q'], composed, repo);
    await runOnce(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'],
      composed,
      repo,
    );
    const pushed = await runOnce(
      'git',
      ['push', 'ssh://agentdeck.invalid/x.git', 'HEAD:main'],
      composed,
      repo,
    );
    expect(pushed.code).not.toBe(0);
    expect(pushed.stderr).toContain('agentdeck: push is a platform step');
  });

  it('F-45 the ssh program of the pin (GIT_SSH, path with a space) still runs for a fetch through the closure (real git)', async () => {
    const dir = join(root, 'f45 ssh dir');
    mkdirSync(dir, { recursive: true });
    const program = join(dir, 'fake-ssh');
    writeFileSync(program, '#!/bin/sh\necho FAKE-SSH-RAN "$@" >&2\nexit 1\n');
    chmodSync(program, 0o755);
    const composed = composeEnv(
      { pin: { ...pin(), ...gitPathPin(), GIT_SSH: program.replace(/\\/g, '/') } },
      {},
    );
    const repo = mkdtempSync(join(root, 'f45-ssh-'));
    await runOnce('git', ['init', '-q'], composed, repo);
    const fetched = await runOnce(
      'git',
      ['fetch', 'ssh://agentdeck.invalid/x.git'],
      composed,
      repo,
    );
    expect(fetched.code).not.toBe(0);
    expect(fetched.stderr).toContain('FAKE-SSH-RAN');
    expect(fetched.stderr).toContain('git-upload-pack');
  });

  it.runIf(isWin)(
    'P25 an unrecognised .cmd wrapper → launch refused with the reason, no host started',
    async () => {
      const run = await launchCli(input({ command: 'custom' }));
      expect(run).toMatchObject({ ok: false, refused: true });
      expect(run.ok ? '' : run.reason).toMatch(/unrecognised \.cmd wrapper/);
    },
  );

  it('P25 a command absent from PATH → refused, named', async () => {
    const run = await launchCli(input({ command: 'no-such-cli-xyz' }));
    expect(run).toMatchObject({ ok: false, refused: true });
    expect(run.ok ? '' : run.reason).toMatch(/not found/);
  });
});

describe('launcher — artifacts and stop', () => {
  it('stdout read as a capped artifact: head + tail kept, the middle dropped and named with its byte count', async () => {
    const run = await launchCli(
      input({ env: { pin: pin(), session: { MODE: 'flood', FLOOD_BYTES: '50000' } } }),
    );
    if (!run.ok) throw new Error(run.reason);
    await waitFor(() => existsSync(sessionFile(run.dir, 'exit')) || undefined, 30_000, 'exit');
    const capped = readArtifact(run.dir, 'stdout', { headBytes: 1000, tailBytes: 2000 });
    expect(capped.truncated).toBe(true);
    expect(capped.bytes).toBeGreaterThan(50_000);
    const dropped = capped.bytes - 3000;
    expect(capped.text).toContain(`[${dropped} bytes dropped]`);
    expect(capped.text.length).toBeLessThan(3200);
    expect(capped.text.startsWith('{"pid":')).toBe(true);
    expect(capped.text.trimEnd().split('\n').at(-1)).toMatch(/^row \d{8}$/);
    const whole = readArtifact(run.dir, 'stdout', { headBytes: 1e6, tailBytes: 1e6 });
    expect(whole.truncated).toBe(false);
    expect(Buffer.byteLength(whole.text)).toBe(capped.bytes);
  });

  it('stop soft: stdin closed → the CLI exits by itself, code 0', async () => {
    const run = await launchCli(input({ env: { pin: pin(), session: { MODE: 'wait' } } }));
    if (!run.ok) throw new Error(run.reason);
    stopLater.push(run.child);
    const outcome = await stopSession(run.dir, 'soft', 10_000);
    expect(outcome).toMatchObject({ how: 'exited', code: 0, residual: [] });
    expect(alive(run.child.pid)).toBe(false);
  });

  it('stop tree: CLI ignoring stdin with a sleeping grandchild → both gone, no residual; a second stop says already-exited', async () => {
    const run = await launchCli(input({ env: { pin: pin(), session: { MODE: 'tree' } } }));
    if (!run.ok) throw new Error(run.reason);
    stopLater.push(run.child);
    const lines = await waitFor(
      () => {
        const got = readLines(run.dir, 'stdout', 0).lines;
        return got.length >= 2 ? got : undefined;
      },
      30_000,
      'grandchild line',
    );
    const grandchild = (JSON.parse(lines[1] ?? '{}') as { grandchild: number }).grandchild;
    expect(alive(grandchild)).toBe(true);
    const outcome = await stopSession(run.dir, 'soft', 800);
    expect(outcome.how).toBe('tree');
    expect(outcome.residual).toEqual([]);
    await waitFor(
      () => (!alive(grandchild) && !alive(run.child.pid)) || undefined,
      15_000,
      'tree gone',
    );
    const again = await waitFor(
      async () => {
        const next = await stopSession(run.dir, 'tree');
        return next.how === 'already-exited' ? next : undefined;
      },
      15_000,
      'exit record',
    );
    expect(again.how).toBe('already-exited');
  });
});

describe('launcher — edges', () => {
  it('a command found only in an extra dir launches; a missing cwd is refused by the host, named', async () => {
    const nodeOnly = { ...pin(), PATH: dirname(process.execPath) };
    const run = await launchCli(
      input({ env: { pin: nodeOnly }, extraDirs: [binDir], readyTimeoutMs: 20_000 }),
    );
    if (!run.ok) throw new Error(run.reason);
    stopLater.push(run.child);
    await linesUntilExit(run.dir);
    const gone = await launchCli(input({ cwd: join(root, 'no such dir') }));
    expect(gone).toMatchObject({ ok: false, refused: true });
    expect(gone.ok ? '' : gone.reason).toMatch(/cwd|no such dir|ENOENT/i);
  });

  it('an explicit relative command resolves against the session cwd, not the core process cwd', async () => {
    // Ядро стоит в своём каталоге: `./bin dir/fake` есть только под cwd сессии (B1r3-F02, сосед).
    const run = await launchCli(
      input({ command: './bin dir/fake', cwd: root, readyTimeoutMs: 20_000 }),
    );
    if (!run.ok) throw new Error(run.reason);
    stopLater.push(run.child);
    await linesUntilExit(run.dir);
  });

  it('a session dir without output, host or exit record: empty artifact, stop says lost', async () => {
    const dir = join(root, 'sessions', 'empty');
    mkdirSync(dir, { recursive: true });
    expect(readArtifact(dir, 'stdout')).toEqual({ text: '', bytes: 0, truncated: false });
    expect(await stopSession(dir, 'tree')).toEqual({
      how: 'lost',
      residual: [],
      reason: 'no host record',
    });
  });

  it('a session with an exit record is already exited: code and residual come from the record', async () => {
    const dir = join(root, 'sessions', 'exited');
    mkdirSync(dir, { recursive: true });
    const residual = [{ pid: 4242, start: 'x' }];
    writeFileSync(
      sessionFile(dir, 'exit'),
      JSON.stringify({ v: 1, code: 7, signal: null, stopped: true, residual, at: 1 }),
    );
    expect(await stopSession(dir, 'soft')).toEqual({ how: 'already-exited', residual, code: 7 });
  });

  it('runOnce: an absent command is refused, a failing one keeps its stderr, a hung one is cut at the deadline', async () => {
    const env = pin();
    const absent = await runOnce('no-such-cli-anywhere', [], env, root);
    expect(absent).toMatchObject({ ok: false, code: null });
    expect(absent.reason).toBeTruthy();
    const failing = await runOnce(
      'node',
      ['-e', "process.stderr.write('bad flag'); process.exit(3)"],
      env,
      root,
    );
    expect(failing).toEqual({ ok: false, code: 3, stdout: '', stderr: 'bad flag' });
    const hung = await runOnce('node', ['-e', 'setTimeout(() => {}, 30000)'], env, root, 300);
    expect(hung).toMatchObject({ ok: false, code: null, reason: 'timeout 300 ms' });
  });
});

/** Каталог git на PATH пина (сам пин теста — только node и обёртки). */
function gitPathPin(): Record<string, string> {
  const path = process.env.PATH ?? process.env.Path ?? '';
  return { PATH: [binDir, dirname(process.execPath), path].join(delimiter) };
}
