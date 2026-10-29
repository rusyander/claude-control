import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CAPTURE_TOOLS } from '../mcp/capture-wrap.ts';
import { SPOOL_RECORD } from '../verifier/spool/ingest.ts';
import { CAPTURE_ENV_NAMES, CAPTURE_RUNNERS, CAPTURE_SHIM } from './capture-shim.ts';
import { scratchIndexTree } from './git.ts';

/**
 * Помощники прокладки захвата (`capture-preload.cjs`) по одному: кто бегун проверки, ключ
 * окружения, голова+хвост лога, куда спрашивать, какой ответ годится, код сигнала, очередь.
 * Сквозной путь (настоящий node под `--require` против ручки ядра) —
 * `api/session-capture.integration.test.ts`.
 */

interface Shim {
  RUNNERS: RegExp[];
  ENV_NAMES: string[];
  SPOOL_CAP: number;
  isCheckRunner(script: unknown): boolean;
  envDigest(env: Record<string, string | undefined>, extra?: string): string;
  envValues(env: Record<string, string | undefined>, extra?: string): Record<string, string | null>;
  logCap(half?: number): { push(c: Buffer | string): void; text(): string; truncated(): boolean };
  connection(
    env: Record<string, string | undefined>,
    readFile?: (p: string) => string,
  ): Record<string, unknown> | undefined;
  answerOf(outcome: unknown): { doubt?: string; answer?: { kind: string } };
  asksCore(ask: unknown, args: string[], tool?: string): boolean;
  exitOf(status: number | null, signal: string | null): number;
  outsideText(answer: unknown): string;
  refuseText(answer: unknown): string;
  spool(
    home: string | undefined,
    record: Record<string, unknown>,
    stderr: (l: string) => void,
  ): string | undefined;
}

const shim = createRequire(import.meta.url)(CAPTURE_SHIM) as Shim;
const root = mkdtempSync(join(tmpdir(), 'capture-shim-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('which node process is a check runner (the main script inside its package)', () => {
  it.each([
    ['C:\\p\\node_modules\\vitest\\vitest.mjs', true],
    ['/p/node_modules/jest-cli/bin/jest.js', true],
    ['/p/node_modules/typescript/bin/tsc', true],
    ['/p/node_modules/typescript/lib/tsc.js', true],
    ['/p/node_modules/eslint/bin/eslint.js', true],
    ['/p/node_modules/prettier/bin/prettier.cjs', true],
    ['/p/node_modules/@playwright/test/cli.js', true],
    ['/p/node_modules/.bin/vitest', false],
    ['/p/src/vitest.mjs', false],
    ['', false],
    [undefined, false],
  ])('%s → %s', (script, expected) => {
    expect(shim.isCheckRunner(script)).toBe(expected);
  });

  it('the core mirrors of the runner list and the env names equal the shim exports (A2-F01)', () => {
    expect(CAPTURE_RUNNERS.map((r) => r.re.source)).toEqual(shim.RUNNERS.map((r) => r.source));
    expect([...CAPTURE_ENV_NAMES]).toEqual(shim.ENV_NAMES);
  });
});

describe('env digest: only the hash of outcome-changing variables', () => {
  it('stable over unrelated vars, changes with CI or a named extra var, values never in the digest', () => {
    const base = shim.envDigest({ PATH: '/a', NODE_ENV: 'test' });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(shim.envDigest({ PATH: '/b', NODE_ENV: 'test' })).toBe(base);
    expect(shim.envDigest({ NODE_ENV: 'test', CI: '1' })).not.toBe(base);
    expect(shim.envDigest({ NODE_ENV: 'test', DB_URL: 'x' }, 'DB_URL')).not.toBe(
      shim.envDigest({ NODE_ENV: 'test', DB_URL: 'y' }, 'DB_URL'),
    );
    expect(shim.envDigest({ NODE_ENV: 'test' }, 'B,A')).toBe(
      shim.envDigest({ NODE_ENV: 'test' }, 'A,B'),
    );
  });

  it('values of the same names go to the core for the caller-run key: unset = null, unrelated vars never sent', () => {
    expect(shim.envValues({ PATH: '/a', NODE_ENV: 'test', CI: '1' })).toEqual({
      CI: '1',
      NODE_ENV: 'test',
      TZ: null,
    });
    expect(shim.envValues({ DB_URL: 'x', SECRET: 's' }, 'DB_URL')).toEqual({
      CI: null,
      DB_URL: 'x',
      NODE_ENV: null,
      TZ: null,
    });
  });
});

describe('log cap: head and tail kept, the middle cut is named', () => {
  it('under the limit → whole text; over it → head + mark + tail', () => {
    const small = shim.logCap(8);
    small.push('abc');
    expect(small.text()).toBe('abc');
    expect(small.truncated()).toBe(false);
    const big = shim.logCap(4);
    big.push('HEAD');
    big.push(Buffer.from('middle-'));
    big.push('TAIL');
    expect(big.truncated()).toBe(true);
    expect(big.text()).toBe('HEAD\n[agentdeck: 7 bytes cut]\nTAIL');
  });
});

describe('where the shim asks', () => {
  it('core session vars → session token, home next to procs.json', () => {
    const got = shim.connection({
      AGENTDECK_CORE_URL: 'http://127.0.0.1:5',
      AGENTDECK_SESSION_TOKEN: 't',
      AGENTDECK_CORE_PROCS: join(root, 'procs.json'),
    });
    expect(got).toEqual({
      url: 'http://127.0.0.1:5',
      bearer: 't',
      tokenKind: 'session',
      home: root,
    });
  });

  it('installed capture: newest loopback core from procs.json, a foreign host never gets the access', () => {
    const files: Record<string, string> = {
      [join('/h', 'capture-token')]: 'cap\n',
      [join('/h', 'procs.json')]: JSON.stringify({
        cores: [
          { url: 'http://127.0.0.1:7001', port: 7001, startedAt: 1 },
          { url: 'http://127.0.0.1:7002', port: 7002, startedAt: 2 },
        ],
      }),
    };
    const read = (p: string): string => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p]!;
    };
    expect(shim.connection({ AGENTDECK_CAPTURE_HOME: '/h' }, read)).toEqual({
      url: 'http://127.0.0.1:7002',
      bearer: 'cap',
      tokenKind: 'capture',
      home: '/h',
    });
    files[join('/h', 'procs.json')] = JSON.stringify({
      cores: [{ url: 'http://evil.example:7003', port: 7003, startedAt: 3 }],
    });
    expect(shim.connection({ AGENTDECK_CAPTURE_HOME: '/h' }, read)).toMatchObject({
      unreachable: 'no core in procs.json',
    });
    delete files[join('/h', 'capture-token')];
    expect(shim.connection({ AGENTDECK_CAPTURE_HOME: '/h' }, read)).toMatchObject({
      unreachable: 'capture access file unread',
    });
    expect(shim.connection({})).toBeUndefined();
  });
});

describe('which core reply is an answer; everything else is doubt → run (F25)', () => {
  it('200 with a known kind → answer; 503, unknown kind, unreachable → doubt with the reason', () => {
    expect(shim.answerOf({ kind: 'reply', status: 200, body: { kind: 'run' } }).answer).toEqual({
      kind: 'run',
    });
    expect(
      shim.answerOf({ kind: 'reply', status: 503, body: { code: 'check-entry-absent' } }).doubt,
    ).toBe('core answered 503 check-entry-absent');
    // Тело с годным kind при не-200 — не ответ: прокси или чужой сервер не должен снять прогон.
    expect(shim.answerOf({ kind: 'reply', status: 409, body: { kind: 'replay' } }).doubt).toBe(
      'core answered 409',
    );
    expect(shim.answerOf({ kind: 'reply', status: 200, body: { kind: 'maybe' } }).doubt).toBe(
      'core answered 200',
    );
    expect(shim.answerOf({ kind: 'unreachable', reason: 'ECONNREFUSED' }).doubt).toBe(
      'ECONNREFUSED',
    );
  });

  it('asked subcommands; exit code like a shell; refusal text names unmet and next', () => {
    expect(shim.asksCore(['test'], ['test', './...'])).toBe(true);
    expect(shim.asksCore(['test'], ['build'])).toBe(false);
    expect(shim.asksCore('*', [])).toBe(true);
    expect(shim.exitOf(3, null)).toBe(3);
    expect(shim.exitOf(null, 'SIGTERM')).toBe(143);
    expect(shim.exitOf(null, 'SIGWINCH')).toBe(129);
    expect(shim.exitOf(null, null)).toBe(1);
    expect(
      shim.refuseText({
        unmet: [{ code: 'window', subject: 'vitest', next: 'wait' }],
        next: 'ask later',
      }),
    ).toBe('agentdeck: check refused\n  - window vitest: wait\nnext: ask later\n');
  });
});

describe('shim hardening (review B2-F03, B2-F04, B2r2-F03, A2-F03)', () => {
  it('installed capture dials the port of the validated url, never a disagreeing `port` field', () => {
    const files: Record<string, string> = {
      [join('/h', 'capture-token')]: 'cap\n',
      [join('/h', 'procs.json')]: JSON.stringify({
        cores: [{ url: 'http://127.0.0.1:7004', port: 9999, startedAt: 1 }],
      }),
    };
    const read = (p: string): string => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p]!;
    };
    expect(shim.connection({ AGENTDECK_CAPTURE_HOME: '/h' }, read)).toMatchObject({
      url: 'http://127.0.0.1:7004',
    });
    files[join('/h', 'procs.json')] = JSON.stringify({
      cores: [{ url: 'http://127.0.0.1:99999', port: 7005, startedAt: 1 }],
    });
    expect(shim.connection({ AGENTDECK_CAPTURE_HOME: '/h' }, read)).toMatchObject({
      unreachable: 'no core in procs.json',
    });
  });

  it('a replay without an integer exit or a log path is doubt (→ run), never exit 0', () => {
    const reply = (body: unknown) => ({ kind: 'reply', status: 200, body });
    const ok = { kind: 'replay', recordId: 'r', exit: 1, logPath: '/l', header: 'h' };
    expect(shim.answerOf(reply(ok)).answer).toEqual(ok);
    for (const bad of [
      { ...ok, exit: undefined },
      { ...ok, exit: '1' },
      { ...ok, exit: 1.5 },
      { ...ok, logPath: undefined },
    ]) {
      expect(shim.answerOf(reply(bad)).doubt).toMatch(/replay without an integer exit/);
    }
  });

  it('the asked subcommand is found past leading options, a toolchain and `-C dir`; mvn/gradle by any goal', () => {
    // Та же таблица, что обёртки PATH получают от ядра.
    const table = new Map(CAPTURE_TOOLS.map((t) => [t.tool, t.ask]));
    const ask = (tool: string): unknown => table.get(tool);
    const asked: [string, string[], boolean][] = [
      ['mvn', ['test'], true],
      ['mvn', ['clean', 'test'], true],
      ['mvn', ['-q', 'test'], true],
      ['mvn', ['clean', 'install'], false],
      ['gradle', ['clean', 'test'], true],
      ['gradle', ['--offline', 'test'], true],
      ['go', ['-C', 'sub', 'test', './...'], true],
      ['go', ['run', 'test'], false],
      ['go', ['build', './...'], false],
      ['cargo', ['+nightly', 'test'], true],
      ['cargo', ['-q', 'test'], true],
      ['cargo', ['run', '--', 'test'], false],
      ['dotnet', ['--diagnostics', 'test'], true],
    ];
    for (const [tool, args, expected] of asked) {
      expect([tool, args, shim.asksCore(ask(tool), args, tool)]).toEqual([tool, args, expected]);
    }
  });

  it('a pass-through with a reason prints one stderr line naming it; without a reason nothing', () => {
    expect(
      shim.outsideText({ kind: 'pass-through', outside: 'cwd /x is not\ninside a repo' }),
    ).toBe('agentdeck: not captured — cwd /x is not inside a repo\n');
    expect(shim.outsideText({ kind: 'pass-through' })).toBe('');
    expect(shim.outsideText({ kind: 'pass-through', outside: '  ' })).toBe('');
  });
});

describe('spool: the result without a core, in the shape the core ingests', () => {
  const record = {
    road: 'path-wrapper',
    argv: ['go', 'test'],
    cwd: '/p',
    envDigest: 'b'.repeat(64),
    env: { CI: 'spool-must-not-keep-this', NODE_ENV: null, TZ: null },
    pid: 42,
    pidStart: 1000,
    exit: 0,
    ms: 5,
    log: 'ok',
    tokenKind: 'capture',
  };

  it('writes <pidStart>-<pid>-<seq>.json atomically; SPOOL_RECORD accepts it; env values never written, only the digest', () => {
    const home = join(root, 'home-a');
    const file = shim.spool(home, record, () => undefined);
    expect(file).toBeDefined();
    const names = readdirSync(join(home, 'spool'));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^1000-42-\d+\.json$/);
    const text = readFileSync(file!, 'utf8');
    const doc = JSON.parse(text) as unknown;
    expect(SPOOL_RECORD.safeParse(doc).success).toBe(true);
    expect(text).not.toContain('spool-must-not-keep-this');
  });

  it('B2-F02: a log the cap cut spools truncated:true, a whole one false', () => {
    const home = join(root, 'home-cut');
    const cut = shim.spool(home, { ...record, truncated: true }, () => undefined);
    const whole = shim.spool(home, { ...record, truncated: false }, () => undefined);
    expect(JSON.parse(readFileSync(cut!, 'utf8'))).toMatchObject({ truncated: true });
    expect(JSON.parse(readFileSync(whole!, 'utf8'))).toMatchObject({ truncated: false });
  });

  it('B2-F01: the spool names the work tree as it is at spool time (the id the core key reads) and the digested env names, never their values', async () => {
    const repo = join(root, 'tree-repo');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'hidden.txt'), 'h1\n');
    writeFileSync(join(repo, 'sub', 'b.txt'), 'b\n');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
    // Флаг, что прячет правку от `add -A`, ядро снимает во временном индексе — прокладка тоже.
    git('update-index', '--assume-unchanged', 'hidden.txt');
    writeFileSync(join(repo, 'hidden.txt'), 'h2\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    const home = join(root, 'home-tree');
    const at = (cwd: string) => {
      const file = shim.spool(home, { ...record, cwd, truncated: false }, () => undefined);
      return JSON.parse(readFileSync(file!, 'utf8')) as { tree: unknown; envNames: unknown };
    };
    const core = await scratchIndexTree(repo);
    expect('value' in core).toBe(true);
    const first = at(join(repo, 'sub'));
    expect(first.tree).toBe((core as { value: string }).value);
    expect(first.envNames).toEqual(['CI', 'NODE_ENV', 'TZ']);
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    expect(at(repo).tree).not.toBe(first.tree);
    // Не репозиторий — личности нет (`null`), ядро такой файл не примет, а не примет его чужим.
    expect(at(join(root, 'home-tree')).tree).toBeNull();
  });

  it('full spool or no home → not written, the reason on stderr', () => {
    const home = join(root, 'home-full');
    mkdirSync(join(home, 'spool'), { recursive: true });
    for (let i = 0; i < shim.SPOOL_CAP; i += 1) {
      writeFileSync(join(home, 'spool', `${i}-1-1.json`), '{}');
    }
    const lines: string[] = [];
    expect(shim.spool(home, record, (l) => lines.push(l))).toBeUndefined();
    expect(lines.join('')).toMatch(/spool full \(500 files\)/);
    expect(shim.spool(undefined, record, (l) => lines.push(l))).toBeUndefined();
    expect(lines.join('')).toMatch(/no core home known/);
  });
});
