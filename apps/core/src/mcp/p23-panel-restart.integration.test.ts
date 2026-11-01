import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CORE_VARS } from '../adapters/launcher/env.ts';
import type { PeerDeps } from '../api/auth.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { peerPid } from '../platform/peer-pid.ts';
import { identityOfPid } from '../platform/process-identity.ts';
import { startSessionStand, type SessionStand } from './__fixtures__/session-stand.ts';
import { MCP_RUN } from './main.ts';

/**
 * P23 (08, F12): перезапуск панели посреди прогона не меняет журнал, прогон идёт дальше.
 *
 * Панель — настоящая прокладка `apps/server/src/routes/core-proxy` отдельным процессом
 * (`proxy-host.ts`), с настоящей таблицей TCP. Ядро — настоящий API в этом процессе с
 * настоящим чтением пира ОС; набор доверенных звеньев — то, что запишет надзор (его в фазе 2
 * нет, тест держит набор сам). Сессия — поддельный CLI, который поднимает настоящий мост
 * `agentdeck` и всё время зовёт `core_state`.
 *
 * Доказывается: (1) убитая и поднятая заново панель не пишет ни строки журнала, сессия та же,
 * вызовы модели не прерывались; (2) число страницы, выданное ядром через старую панель,
 * принимается через новую — прокладка его не чеканит; повтор отказан; (3) ядро судит pid
 * того, кто прислал команду панели (этот тест), а не pid панели и не заголовок клиента.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '../../../server');
const PROXY_HOST = join(SERVER, 'src/routes/core-proxy/__fixtures__/proxy-host.ts');

/** Поддельный CLI: мост MCP как дочерний процесс, `core_state` каждые 100 мс, итог — в журнал-файл. */
const FAKE_CLI = `
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [run, log, stop] = process.argv.slice(2);
const bridge = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', run, 'agentdeck'], { stdio: ['pipe', 'pipe', 'inherit'] });
appendFileSync(log, JSON.stringify({ pid: process.pid, bridge: bridge.pid }) + '\\n');
let id = 0;
const waiting = new Map();
createInterface({ input: bridge.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  waiting.get(msg.id)?.(msg);
  waiting.delete(msg.id);
});
const call = (method, params) => new Promise((done) => {
  id += 1;
  waiting.set(id, done);
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
});
await call('initialize', {});
for (;;) {
  if (existsSync(stop)) break;
  const at = Date.now();
  const msg = await call('tools/call', { name: 'core_state', arguments: {} });
  const body = JSON.parse(msg.result?.content?.[0]?.text ?? 'null');
  appendFileSync(log, JSON.stringify({ at, ok: body?.ok === true, step: body?.result?.step?.stepId ?? null }) + '\\n');
  await new Promise((r) => setTimeout(r, 100));
}
bridge.kill();
process.exit(0);
`;

const children: ChildProcess[] = [];
let stand: SessionStand | undefined;

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  await stand?.close();
  stand = undefined;
});

async function startProxy(
  home: string,
): Promise<{ child: ChildProcess; port: number; pid: number }> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', PROXY_HOST],
    {
      cwd: SERVER,
      env: { ...process.env, AGENTDECK_CORE_HOME: home },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  children.push(child);
  const first = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('proxy did not start')), 15_000);
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).once('line', (line) => {
      clearTimeout(timer);
      done(line);
    });
  });
  const { port, pid } = JSON.parse(first) as { port: number; pid: number };
  return { child, port, pid };
}

async function stopProxy(proxy: { child: ChildProcess }): Promise<void> {
  const exited = new Promise((done) => proxy.child.once('exit', done));
  proxy.child.kill('SIGKILL');
  await exited;
}

function cliLog(path: string): {
  head: { pid: number; bridge: number };
  calls: { at: number; ok: boolean }[];
} {
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    head: rows[0] as { pid: number; bridge: number },
    calls: rows.slice(1) as { at: number; ok: boolean }[],
  };
}

async function until(what: string, check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Прокладка панели живёт в `apps/server`: контейнер Linux (`tools/core-linux.mjs`) несёт
// замыкание её импортов и ставит зависимости сервера — pid пира там читается из /proc.
describe('P23 panel restart mid-run', () => {
  it('a killed and restarted panel proxy changes no journal line, the session keeps running, the core-minted nonce survives', async () => {
    const judged: number[] = [];
    const trusted = new Set<number>();
    const sessionPids = new Set<number>();
    const peer: PeerDeps = {
      peerPid: (query) => peerPid(query),
      isSessionDescendant: async (pid) => {
        judged.push(pid);
        return sessionPids.has(pid);
      },
      trustedHopPids: trusted,
    };
    stand = await startSessionStand({ peer });
    const s = stand;
    // Старт — тем же чтением ОС, что пишет ядро: прокладка сверяет строку до bearer (F10).
    const own = await identityOfPid(process.pid);
    if (!('value' in own)) throw new Error('own process identity is unreadable');
    const home = tempDir('core-home-');
    writeFileSync(join(home, 'token'), s.coreToken);
    writeFileSync(
      join(home, 'procs.json'),
      JSON.stringify({
        v: 1,
        cores: [
          {
            build: 'test',
            pid: process.pid,
            pidStart: own.value.start,
            bootId: newId(),
            port: s.port,
            url: s.url,
            startedAt: Date.now(),
            home,
            portDecision: { rejected: [] },
          },
        ],
        servers: [],
      }),
    );

    const work = tempDir('fake-cli-');
    const script = join(work, 'fake-cli.mjs');
    const log = join(work, 'calls.jsonl');
    const stop = join(work, 'stop');
    writeFileSync(script, FAKE_CLI);
    const cli = spawn(process.execPath, [script, MCP_RUN, log, stop], {
      env: { ...process.env, [CORE_VARS.coreUrl]: s.url, [CORE_VARS.access]: s.sessionToken },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    children.push(cli);
    await until('fake CLI calls', () => existsSync(log) && cliLog(log).calls.length >= 3);
    const { head } = cliLog(log);
    sessionPids.add(head.pid).add(head.bridge);

    const first = await startProxy(home);
    trusted.add(first.pid);
    const viaFirst = async (page: string) =>
      (await (
        await fetch(`http://127.0.0.1:${first.port}/api/core/nonce?page=${page}`)
      ).json()) as {
        nonce: string;
      };
    const page = newId();
    const minted = await viaFirst(page);
    expect(minted.nonce).toEqual(expect.any(String));

    const seqBefore = readJournalLines(s.task.dir, s.task.taskId).lines.length;
    const callsBefore = cliLog(log).calls.length;
    const killedAt = Date.now();
    await stopProxy(first);
    trusted.delete(first.pid);
    const second = await startProxy(home);
    // Надзор записал pid новой панели (в фазе 2 его роль играет тест).
    trusted.add(second.pid);
    await until('calls after restart', () => cliLog(log).calls.length >= callsBefore + 5);

    const after = readJournalLines(s.task.dir, s.task.taskId).lines;
    expect(after.length).toBe(seqBefore);
    const { head: headAfter, calls } = cliLog(log);
    expect(headAfter).toEqual(head);
    expect(cli.exitCode).toBeNull();
    expect(calls.every((c) => c.ok)).toBe(true);
    expect(calls.some((c) => c.at >= killedAt)).toBe(true);
    expect(s.task.state.sessions[s.session.sessionId]?.state).toBe('live');

    const command = async (proof: object, headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${second.port}/api/core/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({
          cmdId: newId(),
          kind: 'pause',
          target: { taskId: s.task.taskId },
          fields: { now: false },
          proof,
        }),
      });
      return (await res.json()) as { code?: string };
    };
    // Число со старой панели, клиент выдаёт себя за процесс сессии заголовком — прокладка
    // ставит свой pid пира, ядро судит этот тест: суд полномочий пройден, пауза из draft —
    // конфликт состояния.
    judged.length = 0;
    const honest = await command(
      { nonce: minted.nonce, page },
      { 'x-agentdeck-peer-pid': String(head.pid) },
    );
    expect(honest.code).toBe('state-conflict');
    expect(judged).toEqual([process.pid]);
    const replay = await command({ nonce: minted.nonce, page });
    expect(replay.code).toBe('nonce-invalid');

    writeFileSync(stop, '');
    await until('fake CLI exit', () => cli.exitCode !== null);
    expect(cli.exitCode).toBe(0);
  }, 90_000);
});
