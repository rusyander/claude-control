import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { journalRecorder } from '../bootstrap/session-road/recorder.ts';
import { CREATED, deps as journalDeps } from '../journal/__fixtures__/journal-harness.ts';
import { createTask } from '../journal/resume.ts';
import { ensureHopHost } from '../routes/hops/hops.ts';
import { createStubRoute, parseStubServerRef } from '../routes/stub/stub.ts';
import { launchSession } from '../session-host/launch.ts';
import { sweepStaleLive } from '../../vitest.temp-sandbox.ts';
import { coreIdentitiesUnder, reapCoreProcessesUnder } from './__fixtures__/reap-home.ts';
import { hasValue } from './os-kind.ts';
import { createLivenessProbe, identityOfPid } from './process-identity.ts';
import type { ProcessIdentity } from './process-table.ts';
import { stopTree } from './tree-stop.ts';

/**
 * Снятие отвязанных процессов ядра по дому (этап 10, зона C, проход 6) — настоящие хосты: хост
 * звеньев (`ensureHopHost`, как его поднимает ядро) и хост сессии (`launchSession`) с «CLI» —
 * спящим node. Хосты отвязаны и переживают своего родителя (P10, P123), поэтому тест и прогон
 * снимают их сами; до прохода 6 они жили днями под `vc-*` и `agentdeck-live\vl-*`.
 * Снятие — только по записям под своим каталогом: хост чужого дома остаётся жить.
 */

const root = mkdtempSync(join(tmpdir(), 'reap-home-'));
const probe = createLivenessProbe(undefined, 0);
const leftovers: ProcessIdentity[] = [];

afterAll(async () => {
  // Свои процессы теста, которые проверка нарочно оставила (чужой дом, неразмеченный каталог).
  await Promise.all(leftovers.map((id) => stopTree(id, { graceMs: 500 }).catch(() => undefined)));
});

const alive = async (id: ProcessIdentity): Promise<boolean> =>
  (await probe.isAlive(id, { fresh: true })) === 'alive';

async function sessionHost(home: string, name: string) {
  const dir = join(home, 'tasks', name, 'sessions', 's1');
  const launched = await launchSession({
    dir,
    sessionId: `reap-${name}-${Date.now()}`,
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1e6)'],
    cwd: home,
    env: {},
  });
  if (!launched.ok) throw new Error(launched.reason);
  return { host: launched.host, cli: launched.child };
}

async function hopHost(home: string): Promise<ProcessIdentity> {
  const handle = await ensureHopHost({ home, retryPauseMs: 10 });
  const identity = await identityOfPid(handle.pid);
  if (!hasValue(identity)) throw new Error(`hop host ${handle.pid}: no identity`);
  return identity.value;
}

describe('reap the detached core processes recorded under one home', () => {
  it('hop host + session host + its CLI under the home die; a host of another home lives', async () => {
    const home = join(root, 'own', '.agentdeck', 'core');
    const other = join(root, 'other');
    mkdirSync(home, { recursive: true });
    const hop = await hopHost(home);
    const session = await sessionHost(home, 't1');
    const foreign = await sessionHost(other, 't2');
    leftovers.push(foreign.host, foreign.cli);
    for (const id of [hop, session.host, session.cli, foreign.host])
      expect(await alive(id)).toBe(true);

    const roles = coreIdentitiesUnder(join(root, 'own'))
      .map((id) => id.role)
      .sort();
    expect(roles).toEqual(['cli', 'hop-host', 'host']);
    const report = await reapCoreProcessesUnder(join(root, 'own'));

    expect(report.residual).toEqual([]);
    for (const id of [hop, session.host, session.cli]) expect(await alive(id)).toBe(false);
    expect(await alive(foreign.host)).toBe(true);
    expect(await alive(foreign.cli)).toBe(true);
  }, 120_000);

  it('stale-run sweep: a marked dead-owner dir gives up its hosts and goes; an unmarked one keeps them', async () => {
    const parent = join(root, 'live');
    const marked = join(parent, 'vl-marked');
    const unmarked = join(parent, 'vl-unmarked');
    for (const dir of [marked, unmarked]) {
      mkdirSync(dir, { recursive: true });
      // Владелец мёртв: номер вне диапазона живых процессов.
      writeFileSync(join(dir, 'owner.pid'), '2147483646');
    }
    writeFileSync(join(marked, 'reap-owned'), '');
    const own = await sessionHost(join(marked, 'stand'), 't3');
    const kept = await sessionHost(join(unmarked, 'stand'), 't4');
    leftovers.push(kept.host, kept.cli);

    const removed = await sweepStaleLive(parent, Date.now());

    expect(await alive(own.host)).toBe(false);
    expect(await alive(own.cli)).toBe(false);
    expect(removed).toContain('vl-marked');
    expect(existsSync(marked)).toBe(false);
    // Каталог прогона до прохода 6: его остатки — решение человека, процессы не трогаются.
    expect(await alive(kept.host)).toBe(true);
  }, 120_000);

  it('stub-route server recorded only by the task journal (resource.created) dies with its home', async () => {
    // Сервер заглушки маршрута (этап 11) переживает ядро (P10) и записан ТОЛЬКО строкой
    // `resource.created` журнала задачи — ни `procs.json`, ни `host.json`. До правки уборка его
    // не видела: прерванный прогон оставлял серверы жить (07.11: 1 в основном дереве, 10 в копии).
    const tasks = join(root, 'stub', '.agentdeck', 'core', 'tasks');
    mkdirSync(tasks, { recursive: true });
    const task = await createTask(tasks, CREATED, journalDeps());
    const route = createStubRoute({ name: 'reap', script: ['left'] });
    const lease = await route.acquire(
      { taskId: task.taskId, model: 'stub-model' },
      journalRecorder(task),
    );
    task.close();
    const ref = lease.resources.find((r) => r.kind === 'stub-server')?.ref ?? '';
    const parsed = parseStubServerRef(ref);
    if ('unreadable' in parsed) throw new Error(parsed.unreadable);
    const server = parsed.identity;
    leftovers.push(server);
    expect(await alive(server)).toBe(true);

    expect(
      coreIdentitiesUnder(join(root, 'stub')).map((id) => [id.role, id.pid, id.start]),
    ).toEqual([['server', server.pid, server.start]]);
    const report = await reapCoreProcessesUnder(join(root, 'stub'));

    expect(report.residual).toEqual([]);
    expect(await alive(server)).toBe(false);
  }, 60_000);
});
