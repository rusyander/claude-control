import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveExecutable } from './exec-resolve.ts';
import { longForm } from './paths.ts';
import { pinEnv, quoteNodeOption, spawnResolved, spawnTracked, writeTextArg } from './spawn.ts';
import { locateCli } from './cli-location.ts';
import { hasValue } from './os-kind.ts';
import { CUSTOM_CMD, npmCmdShim, npmPs1Shim } from './__fixtures__/shims.ts';

const isWin = process.platform === 'win32';
const DUMP = fileURLToPath(new URL('./__fixtures__/argv-dump.mjs', import.meta.url));

/** Аргументы, которые оболочка исказила бы: кавычки, перевод строки, `%`, `$`, `&|<>^`, `\` в конце. */
const NASTY = [
  'plain',
  'with space',
  'quote "inner" end',
  'line1\nline2',
  '%PATH%',
  '$HOME and ${HOME}',
  'trailing back\\',
  '',
  'кириллица ü ñ 漢字',
  '&|<>^!',
  'a\\"b',
  "it's",
];

let root = '';
let binDir = '';
let coreHome = '';

/** Закреплённое окружение: только то, без чего node вообще стартует, + PATH с нашими каталогами. */
function baseEnv(extraPath: string[] = []): Record<string, string> {
  const keep = isWin ? ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR'] : ['HOME', 'TMPDIR'];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH = [...extraPath, dirname(process.execPath)].join(delimiter);
  return env;
}

interface Dump {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  preloaded: string | null;
}

function collect(child: ChildProcess): Promise<{ code: number | null; out: string; err: string }> {
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', (code) => done({ code, out, err }));
  });
}

async function dumpOf(child: ChildProcess): Promise<Dump> {
  const run = await collect(child);
  if (run.code !== 0) throw new Error(`exit ${run.code}: ${run.err}`);
  return JSON.parse(run.out) as Dump;
}

beforeAll(() => {
  // Пробел и не-латиница в каждом звене пути: каталог temp, «core home», каталог обёрток.
  root = mkdtempSync(join(tmpdir(), 'spawn тест ü '));
  coreHome = join(root, 'core home');
  binDir = join(root, 'bin dir');
  const pkg = join(binDir, 'node_modules', 'fake-cli');
  mkdirSync(pkg, { recursive: true });
  mkdirSync(coreHome, { recursive: true });
  copyFileSync(DUMP, join(pkg, 'cli.mjs'));
  if (isWin) {
    writeFileSync(join(binDir, 'fake.cmd'), npmCmdShim('node_modules\\fake-cli\\cli.mjs'));
    const ps1Dir = join(root, 'ps1 only');
    mkdirSync(ps1Dir);
    writeFileSync(join(ps1Dir, 'fake.ps1'), npmPs1Shim('../bin dir/node_modules/fake-cli/cli.mjs'));
  } else {
    const script = join(binDir, 'fake');
    writeFileSync(script, readFileSync(DUMP, 'utf8'));
    chmodSync(script, 0o755);
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('P54 spawn — argv intact at the child, no shell', () => {
  it('P54 .cmd shim (Windows) / shebang script (POSIX) in a non-Latin path with spaces → argv intact', async () => {
    const outcome = spawnResolved({
      command: 'fake',
      args: NASTY,
      cwd: root,
      env: baseEnv([binDir]),
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.resolution.kind).toBe(isWin ? 'shim-node' : 'shebang');
    const dump = await dumpOf(outcome.child);
    expect(dump.argv).toEqual(NASTY);
    // `%PATH%` и `$HOME` не раскрыты — оболочки не было.
    expect(dump.argv).toContain('%PATH%');
  });

  it.runIf(isWin)('P54 .ps1 npm shim parsed to its node target → argv intact', async () => {
    const outcome = spawnResolved({
      command: 'fake',
      args: NASTY,
      cwd: root,
      env: baseEnv([join(root, 'ps1 only')]),
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.resolution).toMatchObject({
      kind: 'shim-node',
      found: join(root, 'ps1 only', 'fake.ps1'),
    });
    expect((await dumpOf(outcome.child)).argv).toEqual(NASTY);
  });

  it('P54 NODE_OPTIONS --require from a core home with spaces: quoted → preload runs; unquoted → node refuses', async () => {
    const preload = join(coreHome, 'pre load.cjs');
    writeFileSync(preload, "globalThis.__preloaded = 'yes';\n");
    const quoted = spawnResolved({
      command: process.execPath,
      args: [DUMP],
      cwd: root,
      env: { ...baseEnv(), NODE_OPTIONS: `--require ${quoteNodeOption(preload)}` },
    });
    if (!quoted.ok) throw new Error(quoted.reason);
    expect((await dumpOf(quoted.child)).preloaded).toBe('yes');
    // Контроль: тот же путь без кавычек рвётся на пробеле — значит, проверка выше не пустая.
    const raw = spawnResolved({
      command: process.execPath,
      args: [DUMP],
      cwd: root,
      env: { ...baseEnv(), NODE_OPTIONS: `--require ${preload}` },
    });
    if (!raw.ok) throw new Error(raw.reason);
    const run = await collect(raw.child);
    expect(run.code).not.toBe(0);
  });
});

describe('P25 spawn — real executable, pinned env, refusals named', () => {
  it('P25 env is pinned: nothing inherited from the core, one PATH on Windows', async () => {
    process.env.AGENTDECK_SPAWN_LEAK_PROBE = 'must-not-reach';
    try {
      const env = { ...baseEnv(), Path: 'C:\\ignored-first', PAYLOAD: 'x' };
      // Последнее написание выигрывает: PATH стоит после Path → берётся PATH.
      const pinned = isWin ? { Path: env.Path, ...baseEnv(), PAYLOAD: 'x' } : env;
      const outcome = spawnResolved({
        command: process.execPath,
        args: [DUMP],
        cwd: root,
        env: pinned,
      });
      if (!outcome.ok) throw new Error(outcome.reason);
      const dump = await dumpOf(outcome.child);
      expect(dump.env.AGENTDECK_SPAWN_LEAK_PROBE).toBeUndefined();
      expect(dump.env.PAYLOAD).toBe('x');
      if (isWin) {
        const pathKeys = Object.keys(dump.env).filter((k) => k.toLowerCase() === 'path');
        expect(pathKeys).toHaveLength(1);
        expect(dump.env[pathKeys[0] ?? '']).toBe(baseEnv().PATH);
        expect(Object.keys(pinEnv({ Path: 'a', PATH: 'b' }, 'win32'))).toEqual(['PATH']);
      }
    } finally {
      delete process.env.AGENTDECK_SPAWN_LEAK_PROBE;
    }
  });

  it.runIf(isWin)(
    'P25 .bat and a hand-written .cmd are refused with a reason, never run through cmd.exe',
    () => {
      const dir = join(root, 'refused');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'batty.bat'), '@echo off\r\necho hi\r\n');
      writeFileSync(join(dir, 'custom.cmd'), CUSTOM_CMD);
      const bat = spawnResolved({ command: 'batty', args: [], cwd: root, env: baseEnv([dir]) });
      expect(bat).toMatchObject({ ok: false });
      expect(bat.ok ? '' : bat.reason).toMatch(/cmd\.exe/);
      const custom = spawnResolved({ command: 'custom', args: [], cwd: root, env: baseEnv([dir]) });
      expect(custom.ok ? '' : custom.reason).toMatch(/unrecognised \.cmd wrapper/);
      const absent = spawnResolved({
        command: 'no-such-tool-xyz',
        args: [],
        cwd: root,
        env: baseEnv(),
      });
      expect(absent.ok ? '' : absent.reason).toMatch(/not found/);
    },
  );

  it('P25 F13: the first PATH dir with a candidate wins (stale binary in a later dir is not preferred)', () => {
    const first = join(root, 'first');
    const later = join(root, 'later');
    mkdirSync(first, { recursive: true });
    mkdirSync(later, { recursive: true });
    if (isWin) {
      writeFileSync(join(first, 'tool.cmd'), npmCmdShim('node_modules\\tool\\cli.mjs'));
      mkdirSync(join(first, 'node_modules', 'tool'), { recursive: true });
      writeFileSync(join(first, 'node_modules', 'tool', 'cli.mjs'), '');
      writeFileSync(join(later, 'tool.exe'), '');
    } else {
      for (const dir of [first, later]) {
        writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
        chmodSync(join(dir, 'tool'), 0o755);
      }
    }
    const env = { PATH: [first, later].join(delimiter) };
    const hit = resolveExecutable('tool', { env });
    expect(hit.ok && hit.found.startsWith(first)).toBe(true);
    const swapped = resolveExecutable('tool', { env: { PATH: [later, first].join(delimiter) } });
    expect(swapped.ok && swapped.found.startsWith(later)).toBe(true);
  });

  it.runIf(!isWin)('P25 POSIX: a file without the exec bit is not a candidate', () => {
    const dir = join(root, 'noexec');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n');
    chmodSync(join(dir, 'tool'), 0o644);
    expect(resolveExecutable('tool', { env: { PATH: dir } })).toMatchObject({
      ok: false,
      absent: true,
    });
  });

  it('P25 long text goes through a file (0600 on POSIX), argv carries only the path', async () => {
    const text = `${'Промпт с "кавычками", $VAR и %VAR%\n'.repeat(4_000)}конец`;
    const file = writeTextArg(join(coreHome, 'prompts'), 'brief.txt', text);
    expect(readFileSync(file, 'utf8')).toBe(text);
    if (!isWin) expect(statSync(file).mode & 0o777).toBe(0o600);
    const outcome = spawnResolved({
      command: process.execPath,
      args: [DUMP, file],
      cwd: root,
      env: baseEnv(),
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    expect((await dumpOf(outcome.child)).argv).toEqual([file]);
  });

  it.runIf(isWin)(
    'P25 F13 cwd given as 8.3 short name → the child runs in the long form; too long a cwd → refused, named',
    async () => {
      const short = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${coreHome.replace(/'/g, "''")}').ShortPath`,
        ],
        { encoding: 'utf8' },
      ).trim();
      expect(short).toMatch(/~\d/);
      const outcome = spawnResolved({
        command: process.execPath,
        args: [DUMP],
        cwd: short,
        env: baseEnv(),
      });
      if (!outcome.ok) throw new Error(outcome.reason);
      expect((await dumpOf(outcome.child)).cwd).toBe(longForm(coreHome));
      let deep = root;
      while (deep.length < 300) deep = join(deep, 'x'.repeat(40));
      mkdirSync(deep, { recursive: true });
      const tooLong = spawnResolved({
        command: process.execPath,
        args: [DUMP],
        cwd: deep,
        env: baseEnv(),
      });
      expect(tooLong.ok ? '' : tooLong.reason).toMatch(/cwd longer than Win32 allows/);
    },
  );

  it('P25 spawnTracked returns the real pid + start time of the child', async () => {
    const outcome = await spawnTracked({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 3000)'],
      cwd: root,
      env: baseEnv(),
      stdio: 'ignore',
    });
    if (!outcome.ok) throw new Error(outcome.reason);
    const identity = outcome.identity;
    expect(identity && hasValue(identity) ? identity.value.pid : -1).toBe(outcome.child.pid);
    expect(identity && hasValue(identity) ? identity.value.start : '').not.toBe('');
    outcome.child.kill('SIGKILL');
  });
});

/**
 * Любой провайдер: одно и то же разрешение и запуск для каждого установленного CLI,
 * только `--version` (без модели). Имена и каталоги — данные теста, как у переходников.
 */
const PROVIDERS: { executable: string; dirs: string[] }[] = [
  { executable: 'claude', dirs: [] },
  { executable: 'codex', dirs: [] },
  { executable: 'qwen', dirs: [] },
  { executable: 'opencode', dirs: [] },
  { executable: 'cn', dirs: [] },
  { executable: 'goose', dirs: [] },
  { executable: 'aider', dirs: [] },
];
const located = PROVIDERS.map((p) => ({ ...p, location: locateCli(p) })).filter(
  (p) => p.location.ok,
);

describe('P25 spawn — installed CLIs of any provider, --version only', () => {
  it.runIf(located.length >= 2)(
    'P25 every located CLI resolves to a real file and answers --version without a shell',
    async () => {
      const results: string[] = [];
      for (const cli of located) {
        const outcome = spawnResolved({
          command: cli.executable,
          args: ['--version'],
          cwd: root,
          env: Object.fromEntries(
            Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
          ),
        });
        if (!outcome.ok) throw new Error(`${cli.executable}: ${outcome.reason}`);
        const timer = setTimeout(() => outcome.child.kill('SIGKILL'), 90_000);
        const run = await collect(outcome.child);
        clearTimeout(timer);
        expect(run.code, `${cli.executable}: ${run.err}`).toBe(0);
        expect(`${run.out}${run.err}`).toMatch(/\d+\.\d+/);
        results.push(`${cli.executable}:${outcome.resolution.kind}`);
      }
      // Хотя бы одна обёртка над node и один нативный файл — оба пути разрешения пройдены.
      expect(results.some((r) => r.endsWith('shim-node'))).toBe(isWin);
      expect(results.length).toBeGreaterThanOrEqual(2);
      console.info(`P25 providers: ${results.join(' ')}`);
    },
    600_000,
  );
});
