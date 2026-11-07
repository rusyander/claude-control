import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedSession } from '../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry } from '../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { ensureCoreHome } from '../platform/core-home.ts';
import { readProcs } from '../platform/procs-file.ts';
import { bootCore } from './boot.ts';

/**
 * Загрузка ядра целиком (00 §Processes, 07 фаза 2) на одноразовом доме: настоящая личность
 * процесса из таблицы ОС, настоящий порт на loopback, настоящий `procs.json` и журнал загрузки.
 * Незаконченная задача открывается, законченная — нет; остановка снимает строку и порт;
 * повторная загрузка на том же доме берёт ту же задачу и тот же токен.
 */

interface LogEvent {
  event: string;
  [key: string]: unknown;
}

function events(logs: string): LogEvent[] {
  return readFileSync(join(logs, 'core.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEvent);
}

async function health(url: string, token?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}/v1/health`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : undefined };
}

describe('core boot', () => {
  it('boots on a fresh home, opens only unfinished tasks, registers in procs.json, stops clean, reboots onto the same task', async () => {
    const home = join(tempDir('boot-'), 'core');
    const layout = ensureCoreHome(home);
    const seed = createTaskRegistry(layout.tasks, deps());
    const open = await seed.create(CREATED);
    const ended = await seed.create(CREATED);
    ended.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'cancelled' } });
    // Закрытый конец — с отчётом; без него задача открылась бы, чтобы её конец закрыли.
    ended.append({
      kind: 'report.final',
      actor: 'core',
      data: { at: 'ended', report: { sha256: 'a'.repeat(64), bytes: 1 } },
    });
    seed.closeAll();

    const core = await bootCore({ home, build: 'boot-test' });
    let stopped = false;
    let firstToken: string | undefined;
    try {
      expect(core.layout.root).toBe(layout.root);
      expect(new URL(core.url).hostname).toBe('127.0.0.1');
      expect(core.port < 5170 || core.port > 5180).toBe(true);
      expect(core.registry.liveTasks().map((t) => t.taskId)).toEqual([open.taskId]);

      firstToken = readFileSync(layout.token, 'utf8').trim();
      expect((await health(core.url)).status).toBe(401);
      expect(await health(core.url, firstToken)).toEqual({
        status: 200,
        body: expect.objectContaining({ ok: true, build: 'boot-test', liveTasks: 1 }),
      });

      const procs = readProcs(layout.procs);
      expect('value' in procs && procs.value.cores).toEqual([
        expect.objectContaining({
          bootId: core.bootId,
          pid: process.pid,
          port: core.port,
          url: core.url,
          build: 'boot-test',
          home: layout.root,
        }),
      ]);
      const log = events(layout.logs);
      expect(log.find((e) => e.event === 'tasks.opened')).toMatchObject({ opened: 1, refused: [] });
      expect(log.find((e) => e.event === 'port')).toMatchObject({ port: core.port });
      // Дирижёр запущен загрузкой один раз: шесть зон этапа 4, две этапа 6 (страж, публикатор),
      // слой пользователя этапа 7, наблюдатель этапа 8, ревью по ссылке этапа 10 (F8), ведущий
      // этапа 11 (зона F) и ворота интеграции этапа 11 (W3-18b).
      expect(log.filter((e) => e.event === 'conductor.started')).toEqual([
        expect.objectContaining({ zones: 13 }),
      ]);
      expect(readFileSync(join(layout.root, 'machine-id'), 'utf8')).toMatch(/^[0-9a-f-]{36}\n$/);

      await core.stop();
      await core.stop();
      stopped = true;
      await expect(fetch(`${core.url}/v1/health`)).rejects.toThrow();
      const after = readProcs(layout.procs);
      expect('value' in after && after.value.cores).toEqual([]);
      expect(events(layout.logs).at(-1)?.event).toBe('stop');
      expect(events(layout.logs).filter((e) => e.event === 'conductor.stopped')).toHaveLength(1);
    } finally {
      if (!stopped) await core.stop();
    }

    // Аренда отпущена при остановке: новая загрузка берёт ту же задачу, токен прежний.
    const again = await bootCore({ home, build: 'boot-test' });
    try {
      expect(again.registry.liveTasks().map((t) => t.taskId)).toEqual([open.taskId]);
      expect(readFileSync(layout.token, 'utf8').trim()).toBe(firstToken);
      expect((await health(again.url, firstToken)).status).toBe(200);
      expect(again.bootId).not.toBe(core.bootId);
    } finally {
      await again.stop();
    }
  }, 60_000);

  it('B a booted core answers the session road with a session token and refuses it without one', async () => {
    const home = join(tempDir('boot-'), 'core');
    const layout = ensureCoreHome(home);
    const seed = createTaskRegistry(layout.tasks, deps());
    const created = await seed.create(CREATED);
    seed.closeAll();
    const core = await bootCore({ home, build: 'boot-test' });
    try {
      const task = core.registry.live(created.taskId);
      if (!task) throw new Error('task not live');
      const session = seedSession(task, { stepKind: 'work' });
      const sessionToken = core.sessionTokens.mint({
        taskId: task.taskId,
        sessionId: session.sessionId,
      });
      const coreToken = readFileSync(layout.token, 'utf8').trim();
      const tools = (token?: string) =>
        fetch(`${core.url}/v1/session/tools`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
      const ok = await tools(sessionToken);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { stepKind: string; tools: { name: string }[] };
      expect(body.stepKind).toBe('work');
      expect(body.tools.length).toBeGreaterThan(0);
      // Без токена, с токеном ядра, с чужой подписью — не сессия.
      expect((await tools()).status).toBe(401);
      expect((await tools(coreToken)).status).toBe(401);
      expect((await tools(`${sessionToken.slice(0, -2)}xx`)).status).toBe(401);
      // Токен сессии не открывает ручки человека и панели.
      expect((await health(core.url, sessionToken)).status).toBe(401);
      // Кодека права у загрузки нет — вопрос о праве отказан, не разрешён.
      const permit = await fetch(`${core.url}/v1/session/permit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: {} }),
      });
      expect(permit.status).toBe(503);
      // Ручка захвата прогонов поднята загрузкой (не 404): без токена — её собственный отказ.
      const capture = await fetch(`${core.url}/v1/session/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(capture.status).toBe(401);
      expect(((await capture.json()) as { code?: string }).code).toBe('capture-token-required');
    } finally {
      await core.stop();
    }
  }, 60_000);

  // Шов BootOptions.identity: ОС, не отдавшая личность самого ядра, — это отказ загрузки, а не
  // загрузка с выдуманным pidStart (аренду с ним другое ядро сочло бы мёртвой).
  describe('refuses to boot when its own identity is unknown, before any side effect', () => {
    it.each([
      [
        'start time hidden',
        { unknown: 'pid 1: start time not exposed' },
        /core identity unknown: pid 1: start time not exposed/,
      ],
      [
        'own pid absent',
        { absent: true as const },
        /core identity unknown: own pid not in the process table/,
      ],
    ])('%s', async (_label, fact, message) => {
      const home = join(tempDir('boot-'), 'core');
      const asked: number[] = [];
      await expect(
        bootCore({
          home,
          build: 'boot-test',
          identity: async (pid) => {
            asked.push(pid);
            return fact;
          },
        }),
      ).rejects.toThrow(message);
      expect(asked).toEqual([process.pid]);
      // Отказ до первого побочного действия: ни дома, ни журнала, ни токена, ни procs.json.
      expect(existsSync(home)).toBe(false);
    });
  });
});
