import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { EngineInfo } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import { openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { EngineHandle, EngineRun } from '../../platform/container-engine.ts';
import { currentOs } from '../../platform/os-kind.ts';
import { releaseWorktree } from '../../platform/resource-release.ts';
import type { ToolRun } from '../../platform/run-tool.ts';
import { createStandRegistry, createStandWatch, readHealth } from '../../verifier/stand/index.ts';
import { releaseByKind, releaseServices } from './release.ts';
import { resourceRows, type ContainerHint } from './refs.ts';

/**
 * Снятие ресурсов ядра (P40/P90): «снято» — только по чтению назад. Стенд: адрес здоровья не
 * прочитан (таймаут, мусорный адрес) — утечка, «не отвечает» только когда порт отказал в
 * соединении. Конец задачи: контейнер, запущенный до краха без записи ресурса, найден по меткам
 * начатого `container-start` и снят; стенд ядра снимается концом задачи, как и контейнеры.
 * Сеть — настоящая (свой сервер на 127.0.0.1); движок — подменённый запуск CLI (`h.run`).
 */

const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((done) => s.close(done));
  }
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}/health`;
}

const fireNow = (fn: () => void) => {
  queueMicrotask(fn);
  return { cancel: () => undefined };
};
const stopped = async () => ({ verified: 'process 4242 gone' });
const fastHealth = (url: string) => readHealth(url, { setTimer: fireNow });

function standRow(health: string): { kind: string; ref: string } {
  return { kind: 'stand', ref: JSON.stringify({ pid: 4242, start: 't0', health }) };
}

describe('P40 stand release: an unread health address is a leak, never "released"', () => {
  it('a hung listener still holding the port (health times out) → leak', async () => {
    const url = await listen(() => undefined);
    const { task } = await openFresh();
    const got = await releaseByKind(task, standRow(url), {
      stopProcess: stopped,
      health: fastHealth,
    });
    expect(got).toMatchObject({ leak: expect.stringMatching(/still (bound|answers)/) });
    task.close();
  });

  it('a garbage health address → leak (nothing was read back)', async () => {
    const { task } = await openFresh();
    const got = await releaseByKind(task, standRow('not a url'), {
      stopProcess: stopped,
      health: fastHealth,
    });
    expect(got).toMatchObject({ leak: expect.any(String) });
    task.close();
  });

  it('nothing listening (connection refused) → verified', async () => {
    const url = await listen((_q, r) => r.end('ok'));
    const s = servers.pop() as Server;
    s.closeAllConnections();
    await new Promise((done) => s.close(done));
    const { task } = await openFresh();
    const got = await releaseByKind(task, standRow(url), {
      stopProcess: stopped,
      health: fastHealth,
    });
    expect(got).toMatchObject({ verified: expect.stringMatching(/not answering/) });
    task.close();
  });
});

/** Движок по сценарию: метки контейнера, `rm`, чтение назад; всё через `h.run`. */
function scriptedEngine(state: { running: Set<string>; labels: Record<string, string> }): {
  handle: (info: EngineInfo) => { value: EngineHandle };
  calls: string[];
} {
  const calls: string[] = [];
  const run: EngineRun = async (_file, args) => {
    const line = args.join(' ');
    calls.push(line);
    const ok = (stdout: string) => ({
      ok: true as const,
      code: 0,
      stdout,
      stderr: '',
      timedOut: false as const,
    });
    if (args[0] === 'ps' && line.includes('--filter label=')) {
      return ok([...state.running].map((id) => `${id}\tsvc\trunning`).join('\n'));
    }
    if (args[0] === 'ps' && line.includes('--filter id=')) {
      const id = line.split('id=')[1] ?? '';
      return ok(state.running.has(id) ? id : '');
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const id = args.at(-1) as string;
      if (!state.running.has(id)) {
        return {
          ok: false as const,
          reason: 'exit 1',
          timedOut: false,
          stderr: `Error response from daemon: No such container: ${id}`,
        };
      }
      return ok(JSON.stringify(state.labels));
    }
    if (args[0] === 'rm') {
      state.running.delete(args.at(-1) as string);
      return ok('');
    }
    return { ok: false as const, reason: `unexpected ${line}`, timedOut: false };
  };
  const handle = (info: EngineInfo) => ({
    value: { info, file: 'docker', prefix: [], env: {}, run } satisfies EngineHandle,
  });
  return { handle, calls };
}

function startedWithoutRow(task: LiveTask, labels: Record<string, string>): void {
  const hint: ContainerHint = { labels, cli: 'docker', socket: 'default' };
  // Ядро умерло между `docker run` и записью ресурса: начатое действие есть, строки ресурса нет.
  task.append({
    kind: 'action.started',
    actor: 'core',
    data: {
      actionId: newId(),
      kind: 'container-start',
      target: 'db',
      idempotencyHint: JSON.stringify(hint),
    },
  });
}

describe('task end releases every core task-end resource, recorded or not (P40)', () => {
  it('a container started before a crash with no resource row is found by labels, recorded and released', async () => {
    const { task } = await openFresh();
    const labels = { 'agentdeck.task': task.taskId, 'agentdeck.service': 'db' };
    const id = 'a'.repeat(64);
    const engine = scriptedEngine({
      running: new Set([id]),
      labels: { ...labels, 'claude.ephemeral': '1' },
    });
    startedWithoutRow(task, labels);
    const out = await releaseServices(task, { handle: engine.handle });
    expect(out).toEqual([{ rid: expect.any(String), verified: `container ${id} absent` }]);
    expect(resourceRows(task).map((r) => r.kind)).toEqual(['container']);
    expect(engine.calls.some((c) => c.startsWith('rm -f -v'))).toBe(true);
    task.close();
  });

  it('the label sweep unread → a named leak, not a clean task end', async () => {
    const { task } = await openFresh();
    startedWithoutRow(task, { 'agentdeck.task': task.taskId, 'agentdeck.service': 'db' });
    const out = await releaseServices(task, {
      handle: () => ({ unknown: 'engine-down: docker: server not answering' }),
    });
    expect(out).toEqual([{ rid: expect.any(String), leak: expect.stringMatching(/engine-down/) }]);
    task.close();
  });

  it('a core stand row is released at task end and its watch detached', async () => {
    const { task } = await openFresh();
    const url = await listen((_q, r) => r.end('ok'));
    const s = servers.pop() as Server;
    s.closeAllConnections();
    await new Promise((done) => s.close(done));
    const rid = newId();
    task.append({
      kind: 'resource.created',
      actor: 'core',
      data: { rid, kind: 'stand', owner: 'core', release: 'task-end', ref: standRow(url).ref },
    });
    const stands = createStandRegistry();
    stands.attach(task.taskId, createStandWatch({ health: url, intervalMs: 60_000 }));
    const out = await releaseServices(task, { stopProcess: stopped, health: fastHealth, stands });
    expect(out).toEqual([{ rid, verified: expect.stringMatching(/not answering/) }]);
    expect(stands.get(task.taskId)).toBeUndefined();
    task.close();
  });

  it('F-191: a locked copy is removed at task end (remove -f -f), verified by the worktree read-back', async () => {
    const repo = join(tempDir('rel-wt-'), 'proj');
    mkdirSync(repo);
    const g = (cwd: string, ...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd,
        encoding: 'utf8',
      }).trim();
    g(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'A');
    const worktree = join(tempDir('rel-wt-'), 'copy');
    g(repo, 'worktree', 'add', '-q', '-b', 'unit', worktree);
    // Запертая копия (крах посреди создания, `worktree add --lock`, человек запер): одного `--force` git мало.
    g(repo, 'worktree', 'lock', '--reason', 'test', worktree);
    // Чтение назад остаётся судьёй: снятие «прошло», а копия в списке — утечка, не «снято».
    const noop = async (): Promise<ToolRun> => ({
      ok: true,
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    expect(await releaseWorktree({ worktree, repo }, currentOs(), noop)).toEqual({
      leak: 'worktree still listed',
    });
    const { task } = await openFresh();
    const out = await releaseByKind(task, {
      kind: 'copy',
      ref: JSON.stringify({ worktree, repo }),
    });
    expect(out).toEqual({ verified: `worktree ${worktree} not listed` });
    expect(g(repo, 'worktree', 'list', '--porcelain')).not.toContain('branch refs/heads/unit');
    expect(existsSync(worktree)).toBe(false);
    task.close();
  });
});
