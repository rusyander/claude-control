import type { EngineInfo } from '@agentdeck/contracts/core/records';
import { describe, expect, it } from 'vitest';
import {
  execIn,
  handleOf,
  knownSockets,
  publishedPorts,
  removePod,
  removeSessionContainer,
  type EngineHandle,
  type EngineRun,
} from '../container-engine.ts';
import type { resolveExecutable } from '../exec-resolve.ts';

/**
 * Решения слоя движка без живого демона (B2r6-F04): снятие говорит с ЗАПИСАННЫМ движком
 * (`handleOf` закрепляет сокет, а не текущий контекст CLI), порты хоста читаются из ответа
 * `inspect`, под снимается с чтением назад, известные сокеты — свои у каждой ОС. Запуск CLI
 * подменён (`run`), разбирается записанный ответ.
 */

const resolved = (file: string) =>
  (() => ({
    ok: true,
    kind: 'native',
    file,
    prefix: [],
    found: file,
  })) as unknown as typeof resolveExecutable;

const info = (over: Partial<EngineInfo>): EngineInfo => ({
  kind: 'colima',
  socket: 'unix:///Users/me/.colima/default/docker.sock',
  composeV2: true,
  composeV1: false,
  cli: 'docker',
  viaSocket: true,
  serverVersion: '27.0.0',
  serverOs: 'linux',
  ...over,
});

const ok = (stdout: string) => ({
  ok: true as const,
  code: 0,
  stdout,
  stderr: '',
  timedOut: false as const,
});
const handle = (run: EngineRun): EngineHandle => ({
  info: info({}),
  file: 'docker',
  prefix: [],
  env: {},
  run,
});

describe('handleOf: release talks to the recorded engine', () => {
  const env = { PATH: '/bin', DOCKER_HOST: 'unix:///other/current.sock' };
  it('a recorded socket address is pinned over the current DOCKER_HOST / context', () => {
    const got = handleOf(info({}), { env, resolve: resolved('docker') });
    expect(got).toMatchObject({
      value: {
        file: 'docker',
        env: { PATH: '/bin', DOCKER_HOST: 'unix:///Users/me/.colima/default/docker.sock' },
      },
    });
  });
  it('a context name (no address) and podman are not pinned: the env stays as is', () => {
    const ctx = handleOf(info({ socket: 'default', viaSocket: false }), {
      env,
      resolve: resolved('docker'),
    });
    expect('value' in ctx && ctx.value.env).toEqual(env);
    const podman = handleOf(info({ cli: 'podman', socket: 'unix:///run/podman/podman.sock' }), {
      env,
      resolve: resolved('podman'),
    });
    expect('value' in podman && podman.value.env).toEqual(env);
  });
  it('CLI gone → absent; CLI found but refused → unknown naming the refusal', () => {
    const gone = (() => ({
      ok: false,
      absent: true,
      searched: [],
    })) as unknown as typeof resolveExecutable;
    expect(handleOf(info({}), { env, resolve: gone })).toEqual({ absent: true });
    const refused = (() => ({
      ok: false,
      absent: false,
      refused: 'batch file needs cmd.exe',
      found: 'docker.cmd',
    })) as unknown as typeof resolveExecutable;
    expect(handleOf(info({}), { env, resolve: refused })).toEqual({
      unknown: 'docker: batch file needs cmd.exe',
    });
  });
});

describe('publishedPorts: host port per container port from inspect', () => {
  it('parses bound ports, skips unbound; no such container → absent; garbage → unknown', async () => {
    const answer =
      '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55432"}],"6379/tcp":null,"80/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]}';
    expect(
      await publishedPorts(
        handle(async () => ok(answer)),
        'c1',
      ),
    ).toEqual({ value: { 5432: 55432 } });
    const missing: EngineRun = async () => ({
      ok: false,
      reason: 'exit 1',
      timedOut: false,
      stderr: 'Error response from daemon: No such object: c1',
    });
    expect(await publishedPorts(handle(missing), 'c1')).toEqual({ absent: true });
    expect(
      await publishedPorts(
        handle(async () => ok('<html>')),
        'c1',
      ),
    ).toMatchObject({
      unknown: expect.stringMatching(/^inspect ports: /),
    });
  });
});

describe('removePod: verified only by reading back', () => {
  it('gone after rm → verified; still listed → leak; read-back failed → leak', async () => {
    const calls: string[] = [];
    const script =
      (podPs: () => ReturnType<EngineRun>): EngineRun =>
      async (_f, args) => {
        calls.push(args.join(' '));
        if (args[1] === 'inspect') return ok('{"app":"x"}');
        return args[1] === 'rm' ? ok('') : podPs();
      };
    expect(await removePod(handle(script(async () => ok(''))), 'p1', 'task-a')).toEqual({
      verified: 'pod p1 absent',
    });
    expect(calls).toEqual([
      'pod inspect --format {{json .Labels}} p1',
      'pod rm -f p1',
      'pod ps -q --no-trunc --filter id=p1',
    ]);
    expect(await removePod(handle(script(async () => ok('p1\n'))), 'p1', 'task-a')).toEqual({
      leak: 'pod still present',
    });
    const unread = await removePod(
      handle(script(async () => ({ ok: false, reason: 'timeout', timedOut: true, stderr: '' }))),
      'p1',
      'task-a',
    );
    expect(unread).toMatchObject({ leak: expect.stringMatching(/^pod ps read-back/) });
  });
});

describe('session finds: the task label is read before rm -f (B2r2-F01)', () => {
  const engine = (labels: () => ReturnType<EngineRun>) => {
    const calls: string[] = [];
    const run: EngineRun = async (_f, args) => {
      calls.push(args.join(' '));
      if (args.includes('inspect')) return labels();
      return ok('');
    };
    return { h: handle(run), calls };
  };
  it("a pod labelled for another task is refused and never removed; its own task's label is removed", async () => {
    const foreign = engine(async () => ok('{"agentdeck.task":"task-b"}'));
    expect(await removePod(foreign.h, 'p1', 'task-a')).toEqual({
      refused: 'pod p1 labelled for task task-b — not removed',
    });
    expect(foreign.calls.some((c) => c.includes(' rm '))).toBe(false);
    const own = engine(async () => ok('{"agentdeck.task":"task-a"}'));
    expect(await removePod(own.h, 'p1', 'task-a')).toEqual({ verified: 'pod p1 absent' });
    expect(own.calls).toContain('pod rm -f p1');
  });
  it('labels unread → leak, never rm; no such container → absent without rm', async () => {
    const unread = engine(async () => ({
      ok: false,
      reason: 'timeout',
      timedOut: true,
      stderr: '',
    }));
    expect(await removeSessionContainer(unread.h, 'c1', 'task-a')).toMatchObject({
      leak: expect.stringMatching(/^container c1 labels unread/),
    });
    expect(unread.calls.some((c) => c.startsWith('rm'))).toBe(false);
    const gone = engine(async () => ({
      ok: false,
      reason: 'exit 1',
      timedOut: false,
      stderr: 'Error: no such container c1',
    }));
    expect(await removeSessionContainer(gone.h, 'c1', 'task-a')).toEqual({
      verified: 'container c1 absent',
    });
    expect(gone.calls.some((c) => c.startsWith('rm'))).toBe(false);
  });
});

describe('execIn goes through the engine run like every other engine call (A2r5-F09)', () => {
  it('argv, stdin and a non-zero exit reach the caller through h.run; a run failure is an error', async () => {
    const seen: { args: string[]; input?: string; acceptNonZero?: boolean }[] = [];
    const run: EngineRun = async (_f, args, options) => {
      seen.push({
        args: [...args],
        ...((options as { input?: string }).input !== undefined
          ? { input: (options as { input?: string }).input }
          : {}),
        ...(options.acceptNonZero ? { acceptNonZero: true } : {}),
      });
      return { ok: true, code: 3, stdout: 'out', stderr: 'err', timedOut: false };
    };
    const h = { ...handle(run), file: 'no-such-engine-cli-xyz' };
    expect(await execIn(h, 'c1', ['psql', '-f', '-'], { input: 'SELECT 1;' })).toEqual({
      code: 3,
      stdout: 'out',
      stderr: 'err',
    });
    expect(seen).toEqual([
      { args: ['exec', '-i', 'c1', 'psql', '-f', '-'], input: 'SELECT 1;', acceptNonZero: true },
    ]);
    const down: EngineRun = async () => ({
      ok: false,
      reason: 'timeout after 5 ms',
      timedOut: true,
    });
    expect(await execIn(handle(down), 'c1', ['true'])).toEqual({ error: 'timeout after 5 ms' });
  });
});

describe('knownSockets per OS (09:30)', () => {
  it('Windows: named pipes only; Linux: XDG podman, rootful podman, colima, orbstack, docker; macOS adds podman machine and Docker Desktop', () => {
    expect(knownSockets({}, 'win32')).toEqual([
      'npipe:////./pipe/podman-machine-default',
      'npipe:////./pipe/docker_engine',
    ]);
    expect(knownSockets({ HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux')).toEqual([
      'unix:///run/user/1000/podman/podman.sock',
      'unix:///run/podman/podman.sock',
      'unix:///home/u/.colima/default/docker.sock',
      'unix:///home/u/.orbstack/run/docker.sock',
      'unix:///var/run/docker.sock',
    ]);
    expect(knownSockets({ HOME: '/Users/u' }, 'darwin')).toEqual([
      'unix:///Users/u/.colima/default/docker.sock',
      'unix:///Users/u/.orbstack/run/docker.sock',
      'unix:///Users/u/.local/share/containers/podman/machine/podman.sock',
      'unix:///Users/u/.docker/run/docker.sock',
      'unix:///var/run/docker.sock',
    ]);
  });
});
