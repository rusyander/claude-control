import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, upsertCase } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';

/**
 * T3 (g5 25.10): e2e без стенда падали на сетапе, история ложилась красной 15/15, и
 * доставка требовала прогона на развилке. `run --health <url>` спрашивает стенд до
 * прогона: не ответил — команда не запускается, кейсы ложатся «заблокирован» с
 * причиной, `gaps` не держит доставку и прогона на развилке не просит.
 *
 * Стенд — настоящий HTTP-сервер этого процесса (401, как у гейта панели), «лежит» —
 * закрытый порт. CLI — асинхронным spawn: синхронный держал бы цикл событий, и сервер
 * не ответил бы.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');
const STARTED = '2026-10-25T10:00:00.000Z';
/** Автотест кейса: оставляет след запуска и пишет зелёный JUnit. */
const CHECK = `import { writeFileSync } from 'node:fs';
writeFileSync('ran.txt', 'ran');
writeFileSync(process.argv[2], '<?xml version="1.0"?><testsuites><testsuite name="s" tests="1"><testcase name="[e2e-001] login" classname="e2e/login.mjs"/></testsuite></testsuites>');
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('tests-cli run --health: стенд спрошен до прогона', { timeout: 180_000 }, () => {
  let dir = '';
  let server: Server | undefined;
  const cli = (...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, [CLI, ...args, '--project', dir], {
        env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '' },
      });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      child.on('close', (code) => done({ code, out }));
    });
  const run = (health: string) =>
    cli(
      'run',
      '--case',
      'e2e:e2e-001',
      '--cmd',
      'node check.mjs {report}',
      '--fresh',
      '--health',
      health,
    );

  /** Порт, который только что был открыт и закрыт, — стенд «лежит». */
  const closedPort = () =>
    new Promise<number>((done) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => done(port));
      });
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-stand-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\nran.txt\n');
    for (const [path, body] of Object.entries({
      'check.mjs': CHECK,
      'e2e/login.mjs': '// e2e\n',
    })) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main');
    git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'feat');
    writeFileSync(join(dir, 'e2e', 'login.mjs'), '// e2e, branch\n');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'feat');
    createGroup(dir, 'e2e', 'e2e');
    upsertCase(
      dir,
      'e2e',
      {
        title: 'Вход на стенд',
        steps: ['node check.mjs'],
        expected: 'login проходит',
        codePaths: ['e2e'],
        automation: { status: 'automated', file: 'e2e/login.mjs' },
      },
      '2026-10-25T09:00:00.000Z',
    );
  });

  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('стенд не ответил — команда не запущена, кейс «заблокирован» с причиной, gaps не держит', async () => {
    const url = `http://127.0.0.1:${await closedPort()}/healthz`;
    const ran = await run(url);
    expect(ran.code, ran.out).toBe(75);
    expect(existsSync(join(dir, 'ran.txt'))).toBe(false);
    const [record] = readRuns(dir);
    expect(record?.exitCode).toBe(75);
    expect(record?.results).toHaveLength(1);
    expect(record?.results[0]?.status).toBe('blocked');
    expect(record?.results[0]?.note).toContain(`Стенд ${url} не отвечает`);
    const gaps = await cli('gaps', '--since', STARTED);
    expect(gaps.out).not.toContain('--base');
    expect(gaps.code, gaps.out).toBe(0);
  });

  it('стенд ответил (401 гейта — тоже жив) — прогон идёт как обычно, кейс зелёный', async () => {
    server = createServer((_req, res) => res.writeHead(401).end());
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    const { port } = server.address() as AddressInfo;
    const ran = await run(`http://127.0.0.1:${port}/healthz`);
    expect(ran.code, ran.out).toBe(0);
    expect(existsSync(join(dir, 'ran.txt'))).toBe(true);
    expect(readRuns(dir)[0]?.results[0]?.status).toBe('passed');
  });
});
