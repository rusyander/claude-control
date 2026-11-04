import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  RouteEndpoint,
  RouteLease,
  RouteRecorder,
  RouteResource,
} from '@agentdeck/contracts/core/routes';
import { bindLoopback } from '../../platform/ports.ts';
import {
  createLivenessProbe,
  type Liveness,
  type ProcessIdentity,
} from '../../platform/process-identity.ts';
import { createStubRoute, parseStubServerRef } from './stub.ts';

const FAKE_CORE = fileURLToPath(new URL('./__fixtures__/fake-core.ts', import.meta.url));
const SCRIPT_MODULE = fileURLToPath(new URL('./__fixtures__/script-module.ts', import.meta.url));

/** Личности запущенных серверов-заглушек (pid + старт из ссылки ресурса), для уборки. */
const seen: ProcessIdentity[] = [];
const see = (ref: string): void => {
  const parsed = parseStubServerRef(ref);
  if (!('unreadable' in parsed)) seen.push(parsed.identity);
};
/**
 * Жизнь сервера по личности (pid + старт), не по номеру: под нагрузкой полного прогона Windows
 * отдаёт освободившийся pid новому процессу за миллисекунды, и `kill(pid, 0)` видел бы чужой
 * живой процесс (g13 p10: «release verified stopped», а `alive(pid)` — true). Снимок свежий.
 */
const life = async (pid: number): Promise<Liveness> => {
  const identity = seen.findLast((one) => one.pid === pid);
  if (!identity) throw new Error(`pid ${pid} was never seen in a resource ref`);
  return createLivenessProbe().isAlive(identity, { fresh: true });
};

afterAll(async () => {
  // Что бы ни случилось в тесте, сервер-заглушка не переживает файл тестов.
  // Только тот же процесс (pid + старт из ссылки ресурса): номер, ушедший процессу соседнего
  // набора тестов, не трогается. Живость — по снимку после вопроса, не из кэша такта.
  const probe = createLivenessProbe();
  for (const identity of seen)
    if ((await probe.isAlive(identity, { fresh: true })) === 'alive') process.kill(identity.pid);
});

function recorder() {
  const events: string[] = [];
  const resources: RouteResource[] = [];
  const record: RouteRecorder = {
    decision: () => undefined,
    created: (r) => {
      resources.push(r);
      events.push(`created:${r.kind}`);
    },
    verified: (_rid, fact) => void events.push(`verified:${fact}`),
    leak: (_rid, reason) => void events.push(`leak:${reason}`),
  };
  return { record, events, resources };
}

/** pid сервера из ссылки ресурса (`…?pid=N…`). */
function serverPid(lease: RouteLease): number {
  const ref = lease.resources.find((r) => r.kind === 'stub-server')?.ref ?? '';
  const pid = Number(new URL(ref).searchParams.get('pid'));
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pid in ${ref}`);
  see(ref);
  return pid;
}

async function chat(endpoint: RouteEndpoint | null, text = 'hi'): Promise<string> {
  const reply = await fetch(`${endpoint?.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'stub-model', messages: [{ role: 'user', content: text }] }),
  });
  return JSON.stringify(await reply.json());
}

async function portFree(endpoint: RouteEndpoint | null): Promise<boolean> {
  try {
    const probe = await bindLoopback(Number(new URL(endpoint?.baseUrl ?? '').port));
    await probe.close();
    return true;
  } catch {
    return false;
  }
}

async function leaseFromKilledCore(): Promise<{ lease: RouteLease; endpoint: RouteEndpoint }> {
  const core = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', FAKE_CORE], {
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  let seen = '';
  const line = await new Promise<string>((done, fail) => {
    core.stdout.on('data', (chunk) => {
      seen += chunk;
      const found = /^LEASE (.*)$/m.exec(seen);
      if (found?.[1]) done(found[1]);
    });
    core.on('exit', (code) => fail(new Error(`fake core exited ${code} before its lease`)));
  });
  // Смерть ядра без уборки: SIGKILL на POSIX, TerminateProcess на Windows.
  const exited = once(core, 'exit');
  core.kill('SIGKILL');
  await exited;
  const taken = JSON.parse(line) as { lease: RouteLease; endpoint: RouteEndpoint };
  // pid — в уборку сразу: упавшая проверка ниже не должна оставить сервер жить.
  serverPid(taken.lease);
  return taken;
}

describe('R:PR-09 stub route — the model server is its own process', () => {
  it('P10 stub route: the core killed mid-lease leaves the server; the restarted core re-attaches to it (no second server) and release stops it', async () => {
    const { lease, endpoint } = await leaseFromKilledCore();
    // Перезапущенное ядро: свой экземпляр маршрута, ДРУГОЙ сценарий в настройках — ответ старым
    // сценарием доказывает, что это тот же сервер, а не новый.
    const restarted = createStubRoute({ name: 'crash', script: ['a second server'] });
    const again = await restarted.endpoint(lease, recorder().record);
    expect(again).toEqual(endpoint);
    expect(await chat(again)).toContain('survived the core');
    const pid = serverPid(lease);
    expect(await life(pid)).toBe('alive');

    const r = recorder();
    const outcome = await restarted.release(lease, r.record);
    expect(outcome.leaks).toEqual([]);
    expect(r.events).toEqual([
      expect.stringMatching(
        /^verified:server stopped \(\d+ process(es)?\), port \d+ free after close$/,
      ),
    ]);
    expect(await life(pid)).toBe('dead');
    expect(await portFree(endpoint)).toBe(true);
    await expect(restarted.endpoint(lease, recorder().record)).rejects.toThrow(/released/);
  }, 60_000);

  it('P10 stub route: clean core shutdown stops every server it holds, re-attached ones included; release afterwards is a no-op', async () => {
    const { lease: orphanLease } = await leaseFromKilledCore();
    const orphanPid = serverPid(orphanLease);
    const route = createStubRoute({ name: 'crash', script: ['own'] });
    const r = recorder();
    await route.endpoint(orphanLease, r.record);
    const own = await route.acquire({ taskId: 't2', model: 'stub-model' }, r.record);
    const ownPid = serverPid(own);
    const ownEndpoint = await route.endpoint(own, r.record);
    expect(await chat(ownEndpoint)).toContain('own');

    const done = await route.shutdown(r.record);
    expect(done.leaks).toEqual([]);
    expect(done.verified).toHaveLength(2);
    expect(await life(orphanPid)).toBe('dead');
    expect(await life(ownPid)).toBe('dead');
    expect(await portFree(ownEndpoint)).toBe(true);
    expect(await route.release(own, r.record)).toEqual({ verified: [], leaks: [] });
  }, 60_000);

  it('R:PR-09 stub route: a function script crosses the process boundary as a module export (factory with data args)', async () => {
    const route = createStubRoute({
      name: 'module',
      script: { module: SCRIPT_MODULE, export: 'echoScript', args: ['from-module'] },
    });
    const r = recorder();
    const lease = await route.acquire(
      { taskId: 't', model: 'stub-model', dialect: 'openai-chat' },
      r.record,
    );
    serverPid(lease);
    expect(await chat(await route.endpoint(lease, r.record), 'ping')).toContain(
      'from-module:ping:1',
    );
    expect(await chat(await route.endpoint(lease, r.record), 'pong')).toContain(
      'from-module:pong:2',
    );
    expect((await route.release(lease, r.record)).leaks).toEqual([]);
  }, 60_000);

  it.runIf(process.platform === 'win32')(
    'R:PR-09 stub route: Windows breakaway — the server started through WMI gets its config by argument and is stopped by identity',
    async () => {
      const route = createStubRoute({ name: 'wmi', script: ['through wmi'], breakaway: true });
      const r = recorder();
      const lease = await route.acquire({ taskId: 't', model: 'stub-model' }, r.record);
      const pid = serverPid(lease);
      expect(await chat(await route.endpoint(lease, r.record))).toContain('through wmi');
      const outcome = await route.release(lease, r.record);
      expect(outcome.leaks).toEqual([]);
      expect(await life(pid)).toBe('dead');
    },
    60_000,
  );

  it('R:PR-09 stub route: a server that cannot start is refused with its reason, nothing left', async () => {
    const route = createStubRoute({
      name: 'broken',
      script: { module: SCRIPT_MODULE, export: 'noSuchExport' },
      startTimeoutMs: 5_000,
    });
    const r = recorder();
    await expect(route.acquire({ taskId: 't', model: 'stub-model' }, r.record)).rejects.toThrow(
      /stub server did not start: .*exited early/,
    );
    expect(r.resources).toEqual([]);
  }, 60_000);
});
