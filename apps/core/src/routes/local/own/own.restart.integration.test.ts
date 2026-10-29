import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RouteLease, RouteResource } from '@agentdeck/contracts/core/routes';
import { hasValue } from '../../../platform/os-kind.ts';
import { identityOfPid } from '../../../platform/process-identity.ts';
import {
  alive,
  BASE_USED,
  fakeGpu,
  identityNow,
  livenessNow,
  RUNNER_BYTES,
} from './__fixtures__/fake-gpu.ts';
import { ownDir } from './__fixtures__/own-options.ts';
import {
  liveRunners,
  recorder,
  restartKit,
  serverPid,
  settle,
  until,
} from './__fixtures__/restart-kit.ts';

/**
 * P10 для `local:own` (11 R:PR-04): ядро убито, когда слот держит аренда с загруженной моделью,
 * а второй запрос ждёт в очереди. Перезапущенное ядро — новый экземпляр маршрута над тем же
 * каталогом аренд: тот же сервер (pid), вторая загрузка не начинается, ждущий не теряет места,
 * слот никогда не выдан двоим. Чужой процесс (номер занят другим) не останавливается.
 */

const root = mkdtempSync(join(tmpdir(), 'own-restart-'));
const { cleanup, track, restartedRoute, killedCore, sweep } = restartKit(root);

afterAll(sweep, 120_000);

describe('P10 local:own — the core dies mid-lease, the model server and the slot queue survive it', () => {
  it('P10 local:own: restarted core re-attaches to the same server (no second server or load); the queued request keeps its place, is granted only after release, never two at once', async () => {
    const { layout, lease, endpoint } = await killedCore('queue');
    const server = await identityNow(serverPid(lease));
    expect(await liveRunners(layout)).toHaveLength(1);

    const { route, slots } = restartedRoute(layout);
    expect(await route.endpoint(lease, recorder().record)).toEqual(endpoint);
    const models = await fetch(`${endpoint.baseUrl}/models`);
    expect(models.status).toBe(200);

    const granted: string[] = [];
    const r = recorder();
    // Новый запрос приходит РАНЬШЕ вернувшегося ждущего — и всё равно проходит после него.
    const fresh = track(route.acquire({ taskId: 'fresh', model: 'tiny-model' }, r.record)).then(
      (l) => (granted.push('fresh'), l),
    );
    await settle(100);
    const queued = track(route.acquire({ taskId: 'queued', model: 'tiny-model' }, r.record)).then(
      (l) => (granted.push('queued'), l),
    );
    // Оба запроса сначала ждут возврата состояния (снимки процессов): под нагрузкой это секунды,
    // поэтому — ожидание события с пределом, не пауза. Место «queued» и порядок выдачи
    // проверяются ниже: потерянное место встало бы в очередь заново, за «fresh».
    expect(await until(() => slots.waiting('gpu') === 2, 30_000)).toBe(true);
    expect(granted).toEqual([]);
    expect(slots.waiting('gpu')).toBe(2);
    expect(await liveRunners(layout)).toHaveLength(1);
    expect(await livenessNow(server)).toBe('alive');

    const released = await route.release(lease, r.record);
    expect(released.leaks).toEqual([]);
    expect(r.events).toEqual([
      expect.stringMatching(/^verified:server lists no loaded model/),
      expect.stringMatching(/^verified:tree stopped: \d+ processes/),
      'verified:lease dir removed',
      expect.stringMatching(/^verified:vram back: used 1\.00 GiB vs baseline 1\.00 GiB/),
    ]);
    expect(await livenessNow(server)).toBe('dead');

    const second = await queued;
    expect(granted).toEqual(['queued']);
    expect(await liveRunners(layout)).toHaveLength(1);
    await settle();
    expect(granted).toEqual(['queued']);
    expect((await route.release(second, r.record)).leaks).toEqual([]);

    const third = await fresh;
    expect(granted).toEqual(['queued', 'fresh']);
    expect(await liveRunners(layout)).toHaveLength(1);
    expect((await route.release(third, r.record)).leaks).toEqual([]);
    expect(slots.held('gpu')).toBe(false);
    expect(await liveRunners(layout)).toEqual([]);
    // Места ждущих сняты вместе с выдачей слота.
    expect(readdirSync(join(layout.workRoot, '.slot-waiting'))).toEqual([]);
  }, 120_000);

  it('P10 local:own: clean core shutdown releases the re-attached lease by the full protocol; the slot is free after it', async () => {
    const { layout, lease } = await killedCore('shutdown');
    const server = await identityNow(serverPid(lease));
    const { route, slots } = restartedRoute(layout);
    const r = recorder();
    const done = await route.shutdown(r.record);
    expect(done.leaks).toEqual([]);
    expect(done.verified).toHaveLength(4);
    expect(await livenessNow(server)).toBe('dead');
    expect(await liveRunners(layout)).toEqual([]);
    expect(slots.held('gpu')).toBe(false);
    expect(await route.shutdown(r.record)).toEqual({ verified: [], leaks: [] });
  }, 120_000);

  it('P10 local:own: a lease record whose pid now belongs to another process → slot free, release stops nothing, that process lives', async () => {
    const layout = ownDir(mkdtempSync(join(root, 'reused-')));
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const foreignPid = foreign.pid ?? 0;
    cleanup.push(foreignPid);
    const workDir = join(layout.workRoot, 'old-lease');
    const resources: RouteResource[] = [
      { rid: 'slot', kind: 'model-slot', ref: 'slot:gpu', release: 'task-end' },
      { rid: 'srv', kind: 'model-server', ref: '', release: 'task-end' },
    ];
    const server = {
      identity: { pid: foreignPid, start: 'not-its-start' },
      origin: 'http://127.0.0.1:9',
      port: 9,
      marker: 'srv',
    };
    resources[1]!.ref = `pid ${foreignPid} start not-its-start ${server.origin}`;
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      join(workDir, 'lease.json'),
      JSON.stringify({
        v: 1,
        leaseId: 'old-lease',
        routeId: 'local:own',
        model: 'tiny-model',
        dialect: 'openai-chat',
        slotKey: 'gpu',
        resources,
        baselineUsedBytes: 1024 ** 3,
        server,
      }),
    );
    const { route, slots } = restartedRoute(layout);
    const r = recorder();
    // Слот свободен: аренда с мёртвым по личности сервером его не держит.
    const fresh = await route.acquire({ taskId: 'fresh', model: 'tiny-model' }, r.record);
    expect(slots.waiting('gpu')).toBe(0);
    const old = { leaseId: 'old-lease', routeId: 'local:own', model: 'tiny-model', resources };
    const outcome = await route.release(old, r.record);
    // Сервер мёртв по личности: в дереве нечего останавливать, чужой процесс жив. Слот ушёл при
    // возврате и занят «fresh» — память карты его модели не называется утечкой этой аренды.
    expect(outcome).toEqual({
      verified: [
        { rid: 'srv', fact: 'tree stopped: 0 processes (0 by marker), none alive' },
        {
          rid: 'slot',
          fact: 'slot returned at restore: model server dead by identity; vram read-back not attributable: slot gpu now held by another lease',
        },
      ],
      leaks: [],
    });
    expect(alive(foreignPid)).toBe(true);
    expect((await route.release(fresh, r.record)).leaks).toEqual([]);
    foreign.kill();
  }, 120_000);

  it('P10 local:own: a journal lease whose server ref differs from the lease record is foreign → every resource a leak, the recorded live process is not stopped', async () => {
    const layout = ownDir(mkdtempSync(join(root, 'mismatch-')));
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const foreignPid = foreign.pid ?? 0;
    cleanup.push(foreignPid);
    const identity = await identityOfPid(foreignPid);
    if (!hasValue(identity)) throw new Error(`identity of ${foreignPid} unread`);
    const workDir = join(layout.workRoot, 'rec-lease');
    mkdirSync(workDir, { recursive: true });
    const origin = 'http://127.0.0.1:9';
    writeFileSync(
      join(workDir, 'lease.json'),
      JSON.stringify({
        v: 1,
        leaseId: 'rec-lease',
        routeId: 'local:own',
        model: 'tiny-model',
        dialect: 'openai-chat',
        slotKey: 'gpu',
        resources: [],
        server: { identity: identity.value, origin, port: 9, marker: 'srv' },
      }),
    );
    const { route } = restartedRoute(layout);
    const journal: RouteLease = {
      leaseId: 'rec-lease',
      routeId: 'local:own',
      model: 'tiny-model',
      resources: [
        { rid: 'srv', kind: 'model-server', ref: `pid 1 start x ${origin}`, release: 'task-end' },
      ],
    };
    // Ссылка аренды не совпала с записью — сервера нет, адреса нет (F-73).
    expect(await route.endpoint(journal, recorder().record)).toBeNull();
    const r = recorder();
    const outcome = await route.release(journal, r.record);
    expect(outcome).toEqual({
      verified: [],
      leaks: [{ rid: 'srv', reason: 'lease rec-lease is not held by local:own (core restarted?)' }],
    });
    expect(alive(foreignPid)).toBe(true);
    foreign.kill();
  }, 60_000);

  it('P10 local:own: a server recorded but never journaled (core died between) is still ours — release stops it under its marker rid', async () => {
    const layout = ownDir(mkdtempSync(join(root, 'unjournaled-')));
    const first = restartedRoute(layout);
    const lease = await first.route.acquire(
      { taskId: 't', model: 'tiny-model' },
      recorder().record,
    );
    const pid = serverPid(lease);
    const server = await identityNow(pid);
    cleanup.push(pid, ...(await liveRunners(layout)));
    // Журнал успел только слот и каталог: сервера и загрузки в нём нет.
    const journal: RouteLease = {
      ...lease,
      resources: lease.resources.filter((x) => x.kind === 'model-slot' || x.kind === 'tmpdir'),
    };
    const restarted = restartedRoute(layout);
    const r = recorder();
    const outcome = await restarted.route.release(journal, r.record);
    expect(outcome.leaks).toEqual([]);
    expect(r.events[0]).toMatch(/^verified:tree stopped: \d+ processes/);
    expect(outcome.verified[0]?.rid).toBe(
      lease.resources.find((x) => x.kind === 'model-server')?.rid,
    );
    expect(await livenessNow(server)).toBe('dead');
    expect(await liveRunners(layout)).toEqual([]);
  }, 120_000);

  // Проверки «сервер не жив» выше читают `alive`: зомби — не живой, как и для таблицы ядра.
  it.runIf(process.platform === 'linux')(
    'P10 local:own fixture: an exited child its parent never reaps (zombie) reads not alive',
    async () => {
      const holder = spawn('sh', ['-c', 'sleep 0.2 & echo $!; exec sleep 30'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      try {
        const line = await new Promise<string>((done) =>
          holder.stdout.once('data', (chunk) => done(String(chunk))),
        );
        const zombie = Number(line.trim());
        const stateOf = (): string => {
          const stat = readFileSync(`/proc/${zombie}/stat`, 'utf8');
          return stat.slice(stat.lastIndexOf(')') + 2).charAt(0);
        };
        expect(await until(() => stateOf() === 'Z', 10_000)).toBe(true);
        expect(alive(zombie)).toBe(false);
      } finally {
        holder.kill('SIGKILL');
      }
    },
  );

  // Чтение памяти карты после освобождения: номер давно снятого раннера достался чужому процессу.
  it('P10 local:own fixture: a runner file whose pid now belongs to a process started after the file was written (pid reused) holds no card memory; a runner alive since before its file does', async () => {
    const dir = mkdtempSync(join(root, 'vram-reuse-'));
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const pid = other.pid ?? 0;
    cleanup.push(pid);
    try {
      expect(hasValue(await identityOfPid(pid))).toBe(true);
      const gpu = fakeGpu(dir);
      const used = async (): Promise<number> => {
        const fact = await gpu();
        if (!hasValue(fact)) throw new Error('fake gpu unread');
        return fact.value.devices[0]?.usedBytes ?? -1;
      };
      const file = join(dir, `${pid}.json`);
      // Файл записан за минуту до старта процесса с этим номером — это не тот раннер.
      writeFileSync(
        file,
        JSON.stringify({ pid, bytes: RUNNER_BYTES, writtenAt: Date.now() - 60_000 }),
      );
      expect(await used()).toBe(BASE_USED);
      // Тот же процесс, файл записан после его старта — раннер, память держит.
      writeFileSync(file, JSON.stringify({ pid, bytes: RUNNER_BYTES, writtenAt: Date.now() }));
      expect(await used()).toBe(BASE_USED + RUNNER_BYTES);
    } finally {
      other.kill();
    }
  }, 60_000);
});
