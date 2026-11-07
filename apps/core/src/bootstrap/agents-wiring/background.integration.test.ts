import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { GoldenIds } from '../../journal/reduce/__fixtures__/agents-golden.ts';
import { ensureCoreHome } from '../../platform/core-home.ts';
import { identityOfPid, type ProcessIdentity } from '../../platform/process-identity.ts';
import { listenersOfTree } from '../../platform/resource-scan.ts';
import { bootCore, type BootedCore } from '../boot.ts';
import { seedLiveSession } from './__fixtures__/seed.ts';

/**
 * Сторож фона на НАСТОЯЩИХ процессах и настоящей загрузке ядра (этап 11, P148, P90/P40): хост
 * сессии — живой процесс `node`, фоновая работа — отделённый `node`-сервер. Хост убит → сирота
 * замечена за шаг обхода, снята общим сносом ресурса с чтением назад, процесса нет. Владелец жив,
 * вывод стоит дольше предела → один `bg-hang`, ничего не снято. Подменено только время
 * (шаг обхода 200 мс, предел тишины 2 с) — проба процессов, снос и журнал настоящие.
 */

const booted: BootedCore[] = [];
const procs: ChildProcess[] = [];
afterEach(async () => {
  for (const core of booted.splice(0)) await core.stop();
  for (const p of procs.splice(0)) if (p.pid && p.exitCode === null) p.kill();
});

const KEEP = 'setInterval(() => {}, 1000)';
const SERVER = "require('http').createServer(() => {}).listen(0); setInterval(() => {}, 1000)";

async function identity(pid: number): Promise<ProcessIdentity> {
  for (let i = 0; i < 50; i += 1) {
    const id = await identityOfPid(pid);
    if ('value' in id) return id.value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`pid ${pid} identity never read`);
}

function node(code: string, detached = false): ChildProcess {
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore', detached });
  if (detached) child.unref();
  procs.push(child);
  return child;
}

interface Line {
  seq: number;
  kind: string;
  data: Record<string, unknown>;
}

const journal = (core: BootedCore, taskId: string): Line[] =>
  readFileSync(join(core.registry.tasksDir, taskId, 'journal.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);

async function waitFor<T>(what: string, probe: () => T | undefined, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const got = probe();
    if (got !== undefined) return got;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function seedTask(
  home: string,
  host: ProcessIdentity,
  bg: { itemId: string; kind: string; pid?: number; outputFile?: string },
): Promise<GoldenIds> {
  const layout = ensureCoreHome(home);
  const seed = createTaskRegistry(layout.tasks, deps());
  const task = await seed.create(CREATED);
  const ids = seedLiveSession(task, host);
  task.append({
    kind: 'bg.started',
    actor: 'core',
    sessionId: ids.sessionId,
    data: {
      itemId: bg.itemId,
      kind: bg.kind,
      excerpt: 'node server.js',
      ownerChain: { ...ids, toolUseId: 'toolu_bash', parentToolUseId: null },
      ...(bg.pid ? { pid: bg.pid } : {}),
      ...(bg.outputFile ? { outputFile: bg.outputFile } : {}),
      startedAt: Date.now(),
    },
  } as never);
  seed.closeAll();
  return ids;
}

const signalsOf = (lines: Line[], id: string) =>
  lines.filter((l) => l.kind === 'signal' && l.data.signal === id);

describe('stage 11 background watch on real processes (P148)', () => {
  it('the session host is killed: bg-orphan names the detached child, reaped through the resource release, read back, the process is gone', async () => {
    const host = node(KEEP);
    const child = node(SERVER, true);
    const hostId = await identity(host.pid as number);
    const childId = await identity(child.pid as number);
    const home = join(tempDir('bg-orphan-'), 'core');
    const ids = await seedTask(home, hostId, {
      itemId: 'bash_srv',
      kind: 'server',
      pid: childId.pid,
    });
    const core = await bootCore({ home, build: 'bg-test', loop: false, agents: { tickMs: 200 } });
    booted.push(core);
    // Пока хост жив, сторож закрепляет личность процесса работы и ничего не снимает.
    await new Promise((r) => setTimeout(r, 1500));
    expect(signalsOf(journal(core, ids.taskId), 'bg-orphan')).toEqual([]);
    host.kill();

    const signal = await waitFor(
      'bg-orphan',
      () => signalsOf(journal(core, ids.taskId), 'bg-orphan')[0],
    );
    expect(signal.data).toMatchObject({ severity: 'warn', action: 'show', subject: 'bash_srv' });
    expect(String(signal.data.detail)).toContain('reaped through resource');
    const lines = await waitFor('bg.ended', () => {
      const all = journal(core, ids.taskId);
      return all.some((l) => l.kind === 'bg.ended') ? all : undefined;
    });
    const created = lines.find((l) => l.kind === 'resource.created' && l.data.kind === 'process');
    expect(JSON.parse(String(created?.data.ref))).toEqual(childId);
    const rid = created?.data.rid;
    expect(lines.some((l) => l.kind === 'resource.released' && l.data.rid === rid)).toBe(true);
    expect(lines.some((l) => l.kind === 'resource.verified' && l.data.rid === rid)).toBe(true);
    expect(lines.find((l) => l.kind === 'bg.ended')?.data).toMatchObject({
      itemId: 'bash_srv',
      how: 'reaped',
    });
    const decision = lines.find(
      (l) =>
        l.kind === 'decision' &&
        l.data.class === 'observer' &&
        (l.data.output as { key?: string }).key === 'bg-orphan:bash_srv',
    );
    expect(decision).toBeDefined();
    // Процесса нет: таблица ОС его больше не знает (или под этим pid уже другой).
    const after = await identityOfPid(childId.pid);
    expect('value' in after && after.value.start === childId.start).toBe(false);
    // Повторный обход второго решения не пишет.
    await new Promise((r) => setTimeout(r, 800));
    expect(signalsOf(journal(core, ids.taskId), 'bg-orphan')).toHaveLength(1);
  }, 60_000);

  it('the owner session ends while its host lives: the still-running child is an orphan too and is reaped', async () => {
    const child = node(SERVER, true);
    const childId = await identity(child.pid as number);
    const home = join(tempDir('bg-session-end-'), 'core');
    const ids = await seedTask(home, await identity(process.pid), {
      itemId: 'bash_srv2',
      kind: 'server',
      pid: childId.pid,
    });
    const core = await bootCore({ home, build: 'bg-test', loop: false, agents: { tickMs: 200 } });
    booted.push(core);
    await new Promise((r) => setTimeout(r, 1500));
    expect(signalsOf(journal(core, ids.taskId), 'bg-orphan')).toEqual([]);
    core.registry.live(ids.taskId)?.append({
      kind: 'session.transition',
      actor: 'core',
      sessionId: ids.sessionId,
      data: { sessionId: ids.sessionId, event: 'exited', from: 'live', to: 'ended' },
    });
    const signal = await waitFor(
      'bg-orphan',
      () => signalsOf(journal(core, ids.taskId), 'bg-orphan')[0],
    );
    expect(String(signal.data.detail)).toContain('reaped through resource');
    // Причина — конец сессии владельца, а не смерть хоста: она в доводах решения наблюдателя.
    const decision = journal(core, ids.taskId).find(
      (l) =>
        l.kind === 'decision' &&
        (l.data.output as { key?: string } | undefined)?.key === 'bg-orphan:bash_srv2',
    );
    expect((decision?.data.reasons as string[] | undefined)?.join(' | ')).toContain(
      `owner session ${ids.sessionId} ended`,
    );
    await waitFor('bg.ended', () =>
      journal(core, ids.taskId).find((l) => l.kind === 'bg.ended' && l.data.how === 'reaped'),
    );
    const after = await identityOfPid(childId.pid);
    expect('value' in after && after.value.start === childId.start).toBe(false);
  }, 60_000);

  it('a background shell with no output for the hang limit: one bg-hang, shown only, nothing stopped', async () => {
    const hostId = await identity(process.pid);
    const home = join(tempDir('bg-hang-'), 'core');
    const outputFile = join(home, '..', 'bash_1.output');
    writeFileSync(outputFile, 'compiling...\n');
    const ids = await seedTask(home, hostId, {
      itemId: 'bash_1',
      kind: 'background-shell',
      outputFile,
    });
    const core = await bootCore({
      home,
      build: 'bg-test',
      loop: false,
      agents: { tickMs: 200, hangAfterMs: 2000 },
    });
    booted.push(core);
    const signal = await waitFor(
      'bg-hang',
      () => signalsOf(journal(core, ids.taskId), 'bg-hang')[0],
    );
    expect(signal.data).toMatchObject({ severity: 'warn', action: 'show', subject: 'bash_1' });
    expect(String(signal.data.detail)).toContain('wrote no output');
    await new Promise((r) => setTimeout(r, 800));
    const lines = journal(core, ids.taskId);
    expect(signalsOf(lines, 'bg-hang')).toHaveLength(1);
    expect(lines.some((l) => l.kind === 'bg.ended')).toBe(false);
    expect(lines.some((l) => l.kind === 'resource.created')).toBe(false);
    expect(
      lines.some(
        (l) =>
          l.kind === 'session.transition' &&
          l.data.sessionId === ids.sessionId &&
          l.data.to !== 'live',
      ),
    ).toBe(false);
  }, 60_000);

  it('a quiet background shell whose process listens on a port is a server: no bg-hang; the same without a port hangs', async () => {
    const hostId = await identity(process.pid);
    const home = join(tempDir('bg-server-'), 'core');
    // Оба — фоновые оболочки CLI с молчащим файлом вывода; слушает порт только первая.
    const server = node(
      "require('http').createServer(() => {}).listen(0, '127.0.0.1'); setInterval(() => {}, 1000)",
    );
    const quiet = node(KEEP);
    const serverOut = join(home, '..', 'bash_srv.output');
    const quietOut = join(home, '..', 'bash_quiet.output');
    writeFileSync(serverOut, 'listening\n');
    writeFileSync(quietOut, 'compiling...\n');
    const serverId = await identity(server.pid as number);
    await identity(quiet.pid as number);
    // Порт открыт до первого обхода: сервер успел подняться (та же проба таблицы, что у сторожа).
    for (let i = 0; i < 100; i += 1) {
      const ports = await listenersOfTree(serverId);
      if ('value' in ports && ports.value.length > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const srvIds = await seedTask(home, hostId, {
      itemId: 'bash_srv',
      kind: 'background-shell',
      pid: server.pid as number,
      outputFile: serverOut,
    });
    const quietIds = await seedTask(home, hostId, {
      itemId: 'bash_quiet',
      kind: 'background-shell',
      pid: quiet.pid as number,
      outputFile: quietOut,
    });
    const core = await bootCore({
      home,
      build: 'bg-test',
      loop: false,
      agents: { tickMs: 200, hangAfterMs: 2000 },
    });
    booted.push(core);
    // Двойник без порта зависает — значит, предел тишины прошёл и для сервера.
    await waitFor(
      'bg-hang of the portless twin',
      () => signalsOf(journal(core, quietIds.taskId), 'bg-hang')[0],
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(signalsOf(journal(core, srvIds.taskId), 'bg-hang')).toEqual([]);
    expect(server.exitCode).toBeNull();
  }, 60_000);
});
