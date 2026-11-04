import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { deadSocket, startEngineStub } from './__fixtures__/engine-stub.ts';
import {
  EPHEMERAL_LABEL,
  engineFact,
  engineHandle,
  engineKind,
  ensureCacheVolume,
  listByLabels,
  removeCacheVolume,
  removeEphemeral,
  runContainer,
  runEngine,
  type EngineHandle,
  type EngineRun,
} from './container-engine.ts';
import { resolveExecutable } from './exec-resolve.ts';

/**
 * P58 / P44 для движка контейнеров. Сокет-заглушка говорит с НАСТОЯЩИМ CLI `docker` (вывод
 * разбирается настоящий): нет CLI → `absent`; ВМ остановлена (мёртвый сокет) → `unknown`, не
 * «нет»; только сокет Podman → движок найден через сокет. Настоящий движок машины — отдельный
 * блок: запуск по меткам, отказ снимать чужое, снятие с чтением назад. Нет CLI или движка —
 * блок пропущен, причина видна в отчёте, зелёного без прогона нет.
 */

const ZONE_LABEL = 'agentdeck.zone-f-test';
// Значение метки — своё у прогона файла: уборка `afterAll` соседнего файла (параллельно) иначе
// снесла бы мой живой контейнер посреди работы (pg_dump exit 137).
const ZONE_RUN = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
/**
 * Окно класса `engine.info` (10 с) на 3-4 запуска CLI; под нагрузкой параллельных прогонов
 * Windows запускает `docker.exe` по 2-3 с — эти тесты проверяют разбор ответа, не потолок
 * (потолок — таблица P44 ниже), поэтому окно у них ×6.
 */
const slack = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms * 6);
  return { cancel: () => clearTimeout(t) };
};
const dockerCli = resolveExecutable('docker');
const haveCli = dockerCli.ok;
const realEngine = haveCli
  ? await engineHandle({ setTimer: slack })
  : { unknown: 'docker CLI not in PATH' };
const real = 'value' in realEngine ? realEngine.value : undefined;
const IMAGES = ['alpine:3.21', 'agentdeck-core-linux:22'];
async function localImage(h: EngineHandle): Promise<string | undefined> {
  for (const image of IMAGES) {
    const got = await runEngine(h, ['image', 'inspect', '--format', '{{.Id}}', image]);
    if (got.ok) return image;
  }
  return undefined;
}
const image = real ? await localImage(real) : undefined;
const empty = mkdtempSync(join(tmpdir(), 'agentdeck-engine-nopath-'));

afterAll(async () => {
  if (real) {
    // Подчистка на красный посреди теста: только свои контейнеры этой зоны, по метке.
    const left = await listByLabels(real, { [EPHEMERAL_LABEL]: '1', [ZONE_LABEL]: ZONE_RUN });
    const ids = 'value' in left ? left.value.map((row) => row.id) : [];
    if (ids.length > 0) await runEngine(real, ['rm', '-f', '-v', ...ids], { timeoutMs: 120_000 });
  }
  rmSync(empty, { recursive: true, force: true });
});

const fireNow = (fn: () => void) => {
  queueMicrotask(fn);
  return { cancel: () => undefined };
};

describe('engine kind from recorded version answers (macOS engines by code)', () => {
  const v = (platform: string, components: string[], context = 'default') => ({
    Client: { Context: context },
    Server: { Platform: { Name: platform }, Components: components.map((Name) => ({ Name })) },
  });
  it.each([
    [
      'Docker Desktop',
      v('Docker Desktop 4.86.0 (236216)', ['Engine']),
      'docker',
      'npipe:////./pipe/x',
      'docker',
    ],
    [
      'docker-ce linux',
      v('Docker Engine - Community', ['Engine']),
      'docker',
      'unix:///var/run/docker.sock',
      'docker',
    ],
    [
      'OrbStack',
      v('OrbStack', ['Engine'], 'orbstack'),
      'docker',
      'unix:///Users/u/.orbstack/run/docker.sock',
      'orbstack',
    ],
    [
      'Colima',
      v('', ['Engine'], 'colima'),
      'docker',
      'unix:///Users/u/.colima/default/docker.sock',
      'colima',
    ],
    [
      'Podman socket',
      v('', ['Podman Engine', 'Engine']),
      'docker',
      'unix:///run/user/1000/podman/podman.sock',
      'podman',
    ],
    ['Podman CLI', { Client: {}, Server: {} }, 'podman', 'podman', 'podman'],
    ['unknown server', v('', ['Containerd']), 'docker', 'unix:///x.sock', 'docker-compatible'],
  ] as const)('%s → kind', (_name, version, cli, socket, kind) => {
    expect(engineKind(version, cli, socket)).toBe(kind);
  });
});

describe('P44 engine.info fault table: never absent from a failed read', () => {
  const resolveDocker = (() => ({
    ok: true,
    kind: 'native',
    file: 'docker',
    prefix: [],
    found: 'docker',
  })) as unknown as typeof resolveExecutable;
  const probe = (run: EngineRun, extra: Parameters<typeof engineFact>[0] = {}) =>
    engineFact({ resolve: resolveDocker, sockets: [], run, ...extra });
  const failed =
    (reason: string): EngineRun =>
    async () => ({
      ok: false,
      reason,
      timedOut: false,
      code: null,
      stderr: '',
    });
  it('timeout → unknown', async () => {
    const never: EngineRun = () => new Promise(() => undefined);
    expect(await probe(never, { setTimer: fireNow })).toEqual({
      unknown: 'timeout after 10000 ms',
    });
  });
  it.each([
    ['ENOENT', 'spawn docker ENOENT'],
    ['EPERM', 'spawn docker EPERM'],
  ])('%s on the CLI → unknown engine-down', async (_code, reason) => {
    const got = await probe(failed(reason));
    expect(got).toMatchObject({
      unknown: expect.stringMatching(/^engine-down: docker: .*E(NOENT|PERM)/),
    });
  });
  it('garbage version output → unknown', async () => {
    const garbage: EngineRun = async () => ({
      ok: true,
      code: 0,
      stdout: '<html>',
      stderr: '',
      timedOut: false,
    });
    expect(await probe(garbage)).toMatchObject({ unknown: expect.stringMatching(/not JSON/) });
  });
  it('podman CLI only (recorded answer) → podman, server = its own client', async () => {
    const resolvePodman = ((name: string) =>
      name === 'podman'
        ? { ok: true, kind: 'native', file: 'podman', prefix: [], found: 'podman' }
        : { ok: false, absent: true, searched: [] }) as unknown as typeof resolveExecutable;
    const run: EngineRun = async (_file, args) =>
      args[0] === 'version'
        ? {
            ok: true,
            code: 0,
            stdout: '{"Client":{"Version":"5.2.0","Os":"linux"}}',
            stderr: '',
            timedOut: false,
          }
        : { ok: true, code: 0, stdout: 'podman compose 1.0', stderr: '', timedOut: false };
    const got = await engineFact({ resolve: resolvePodman, sockets: [], run });
    expect(got).toEqual({
      value: {
        kind: 'podman',
        socket: 'podman',
        composeV2: true,
        composeV1: false,
        cli: 'podman',
        viaSocket: false,
        serverVersion: '5.2.0',
        serverOs: 'linux',
      },
    });
  });
  it('removeEphemeral refuses a container without claude.ephemeral and never calls rm', async () => {
    const calls: string[][] = [];
    const run: EngineRun = async (_file, args) => {
      calls.push([...args]);
      return { ok: true, code: 0, stdout: '{"agentdeck.task":"t"}', stderr: '', timedOut: false };
    };
    const h: EngineHandle = { info: {} as never, file: 'docker', prefix: [], env: {}, run };
    const got = await removeEphemeral(h, 'abc123', { 'agentdeck.task': 't' });
    expect(got).toEqual({ refused: 'container abc123 not ours: no claude.ephemeral=1 label' });
    expect(calls).toEqual([
      ['container', 'inspect', '--format', '{{json .Config.Labels}}', 'abc123'],
    ]);
  });
  it('a CLI failure saying «context not found» is a leak, never a verified absent container or volume', async () => {
    const run: EngineRun = async () => ({
      ok: false,
      code: 1,
      reason: 'exit 1',
      timedOut: false,
      stderr: 'context "colima": context not found: open /x/meta.json: no such file or directory',
    });
    const h: EngineHandle = { info: {} as never, file: 'docker', prefix: [], env: {}, run };
    expect(await removeEphemeral(h, 'abc123', {})).toMatchObject({
      leak: expect.stringContaining('context not found'),
    });
    expect(await removeCacheVolume(h, 'agentdeck-cache-pnpm')).toMatchObject({
      leak: expect.stringContaining('context not found'),
    });
  });
  it('a docker CLI found but refused (wrapper needing a shell) → unknown, not «install Docker»', async () => {
    const resolveRefused = ((name: string) =>
      name === 'docker'
        ? { ok: false, absent: false, refused: 'batch file needs cmd.exe', found: 'docker.cmd' }
        : { ok: false, absent: true, searched: [] }) as unknown as typeof resolveExecutable;
    expect(await engineFact({ resolve: resolveRefused, sockets: [] })).toEqual({
      unknown: 'engine-cli-refused: docker.cmd: batch file needs cmd.exe',
    });
  });
});

describe.runIf(haveCli)('P58 socket stub through the real docker CLI', { timeout: 90_000 }, () => {
  const base = { ...process.env, DOCKER_CONFIG: empty };
  it('no docker and no podman in PATH → absent', async () => {
    expect(await engineFact({ env: { ...base, PATH: empty, Path: empty }, sockets: [] })).toEqual({
      absent: true,
    });
  });
  it('engine VM stopped (dead socket, no known socket answers) → unknown engine-down, not absent', async () => {
    const got = await engineFact({
      env: { ...base, DOCKER_HOST: deadSocket('vm') },
      sockets: [deadSocket('known')],
      socketExists: () => true,
      setTimer: slack,
    });
    // Под нагрузкой общего прогона сам docker.exe не укладывается в 8 с на мёртвом канале — это
    // тот же мёртвый движок, другой словами; свойство теста — engine-down, а не absent.
    expect(got).toMatchObject({
      unknown: expect.stringMatching(
        /^engine-down: docker: (server not answering|timeout after \d+ ms)/,
      ),
    });
  });
  it('only a Podman socket answers → engine found through the socket, kind podman', async () => {
    const stub = await startEngineStub('podman');
    try {
      const got = await engineFact({
        env: { ...base, DOCKER_HOST: deadSocket('vm2') },
        sockets: [deadSocket('docker'), stub.host],
        socketExists: () => true,
        setTimer: slack,
      });
      expect(got).toMatchObject({
        value: {
          kind: 'podman',
          socket: stub.host,
          viaSocket: true,
          cli: 'docker',
          serverOs: 'linux',
        },
      });
      expect(stub.requests).toContain('GET /version');
    } finally {
      await stub.close();
    }
  });
  it('cache volume: created with agentdeck.cache, kept on re-ensure, removed only with the label (stub engine)', async () => {
    const stub = await startEngineStub('docker');
    try {
      const h = await engineHandle({
        env: { ...base, DOCKER_HOST: stub.host },
        sockets: [],
        setTimer: slack,
      });
      expect(h).toMatchObject({ value: { info: { kind: 'docker', socket: stub.host } } });
      if (!('value' in h)) return;
      expect(await ensureCacheVolume(h.value, 'agentdeck-cache-pnpm')).toEqual({
        value: 'created',
      });
      expect(stub.volumes.get('agentdeck-cache-pnpm')).toEqual({ 'agentdeck.cache': '1' });
      expect(await ensureCacheVolume(h.value, 'agentdeck-cache-pnpm')).toEqual({
        value: 'existed',
      });
      stub.volumes.set('user-data', {});
      expect(await ensureCacheVolume(h.value, 'user-data')).toMatchObject({
        unknown: expect.stringMatching(/not ours/),
      });
      expect(await removeCacheVolume(h.value, 'user-data')).toMatchObject({
        refused: expect.any(String),
      });
      expect(stub.volumes.has('user-data')).toBe(true);
      expect(await removeCacheVolume(h.value, 'agentdeck-cache-pnpm')).toEqual({
        verified: 'volume agentdeck-cache-pnpm absent',
      });
      expect(stub.volumes.has('agentdeck-cache-pnpm')).toBe(false);
    } finally {
      await stub.close();
    }
  });
});

// Имя блока постоянное — по нему кейс блока тестов связан с тестом; причина пропуска — своей строкой.
if (!real) {
  it.skip(`real engine skipped: ${'unknown' in realEngine ? realEngine.unknown : 'no engine'}`, () =>
    undefined);
} else if (!image) it.skip(`real engine skipped: no local ${IMAGES.join(' / ')}`, () => undefined);
describe.runIf(real !== undefined && image !== undefined)(
  'real engine of this machine',
  { timeout: 120_000 },
  () => {
    it('probe names kind, socket and compose; labelled run is found by labels and removed with read-back; a foreign task label is refused', async () => {
      const h = real!;
      expect(h.info.socket).toMatch(/:\/\//);
      expect(typeof h.info.composeV2).toBe('boolean');
      const task = newId();
      const labels = { 'agentdeck.task': task, [ZONE_LABEL]: ZONE_RUN };
      const id = await runContainer(h, {
        image: image!,
        labels,
        env: {},
        ports: [],
        command: ['sleep', '300'],
      });
      expect(id).toMatchObject({ value: expect.stringMatching(/^[0-9a-f]{64}$/) });
      if (!('value' in id)) return;
      const found = await listByLabels(h, { 'agentdeck.task': task, [EPHEMERAL_LABEL]: '1' });
      expect(found).toMatchObject({ value: [{ id: id.value }] });
      const foreign = await removeEphemeral(h, id.value, { 'agentdeck.task': newId() });
      expect(foreign).toMatchObject({ refused: expect.stringMatching(/not ours/) });
      expect(await listByLabels(h, { 'agentdeck.task': task })).toMatchObject({
        value: [{ id: id.value }],
      });
      expect(await removeEphemeral(h, id.value, { 'agentdeck.task': task })).toEqual({
        verified: `container ${id.value} absent`,
      });
      expect(await listByLabels(h, { 'agentdeck.task': task })).toEqual({ value: [] });
    }, 120_000);
  },
);
