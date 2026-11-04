import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../../context.ts';
import { sandboxPaths, sweepIdleSandboxes } from '../../domains/sandbox/SandboxConfig.ts';
import { registerSandboxRoutes, SANDBOX_STOP_REASON } from './sandbox-routes.ts';
import {
  FAKE_TURN,
  fakeCorePort,
  waitFor,
  type FakeCorePort,
} from '../../domains/project-tests/agent/__fixtures__/fake-core-port.ts';

/**
 * Прогон в песочнице, которой больше нет.
 *
 * Подметание сносит песочницу вместе с перепиской (`config/projects/*.jsonl`).
 * Маршрут молча собирал на её месте ПУСТУЮ: `--resume` не находил сессию, а
 * свежий вопрос уходил в конфигурацию без единого правила и скилла — при том,
 * что панель продолжала показывать прежний состав. Ответ приходил такой, будто
 * проверяемое правило ни на что не влияет; ложный отрицательный ответ хуже
 * отказа, поэтому истечение называется вслух.
 *
 * Корень подметания подставной: настоящие песочницы (там чужие данные) тест не
 * трогает, а реестр истёкших ведётся по имени папки, а не по её месту.
 */
describe('маршрут прогона песочницы', () => {
  let root: string;
  let app: FastifyInstance;
  const id = `qa-gone-${process.pid}`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-sandbox-routes-'));

    const ctx = {
      location: { paths: { root, appData: join(root, 'agentdeck') } },
      // Песочница работает только при активном Claude — провайдер называем явно.
      store: { getSettings: () => ({ provider: 'claude' }) },
    } as unknown as ServerContext;

    app = Fastify();
    registerSandboxRoutes(app, ctx);
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(sandboxPaths(id).root, { recursive: true, force: true });
  });

  /** Песочница, которую унесло подметание по простою. */
  function sweepAway(): void {
    const dir = join(root, id);
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', '.credentials.json'), '{"token":"пример"}');

    const old = new Date(Date.now() - 3 * 60 * 60_000);
    for (const path of [join(dir, 'config', '.credentials.json'), join(dir, 'config'), dir]) {
      utimesSync(path, old, old);
    }

    expect(sweepIdleSandboxes(Date.now(), root, 60 * 60_000).removed).toEqual([id]);
  }

  it('на истёкшей песочнице отвечает отказом 410 с причиной', async () => {
    sweepAway();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sandbox/run',
      payload: { id, prompt: 'проверь правило' },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json<{ message: string }>().message).toContain('по простою');
  });

  it('пустую песочницу на месте истёкшей не собирает', async () => {
    sweepAway();

    await app.inject({
      method: 'POST',
      url: '/api/sandbox/run',
      payload: { id, prompt: 'привет' },
    });

    expect(existsSync(sandboxPaths(id).root)).toBe(false);
  });

  it('без текста вопроса — 400 раньше ядра; остановка без разговора отвечает ok:false', async () => {
    const incomplete = await app.inject({
      method: 'POST',
      url: '/api/sandbox/run',
      payload: { id },
    });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json()).toMatchObject({ messageCode: 'sandbox-ask-incomplete' });

    const stop = await app.inject({ method: 'POST', url: `/api/sandbox/${id}/stop` });
    expect(stop.json()).toEqual({ ok: false });
  });
});

/**
 * Разговор песочницы — задача ядра `chat@1` (этап 10, F6). Подменена только граница процесса
 * ядра (`fake-core-port.ts`); маршрут, рабочая папка-репозиторий и `TestsCoreRun` настоящие.
 */
describe('разговор песочницы через ядро', () => {
  let root: string;
  let app: FastifyInstance;
  let core: FakeCorePort;
  const id = `qa-core-${process.pid}`;

  const frames = (body: string): Array<Record<string, unknown>> =>
    body
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);

  function boot(options: Parameters<typeof fakeCorePort>[0]): void {
    core = fakeCorePort(options);
    const ctx = {
      location: { paths: { root, appData: join(root, 'agentdeck') } },
      store: { getSettings: () => ({ provider: 'claude' }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerSandboxRoutes(app, ctx, { corePort: () => core.port });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-sandbox-core-'));
    const { configDir, workDir } = sandboxPaths(id);
    mkdirSync(configDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(sandboxPaths(id).root, { recursive: true, force: true });
  });

  it('задача на месте в рабочей папке: каталог конфигурации — окружением, без брифа, только слой человека; ответ потоком', async () => {
    boot({ turn: FAKE_TURN });
    const { configDir, workDir } = sandboxPaths(id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/sandbox/run',
      payload: { id, prompt: 'проверь правило' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    // Рабочая папка стала репозиторием с головой — иначе оценка ядра отказала бы.
    expect(existsSync(join(workDir, '.git'))).toBe(true);
    expect(core.estimates[0]).toMatchObject({
      request: 'проверь правило',
      repos: [{ path: workDir, baseRef: null }],
      scenario: { preset: 'chat' },
      placement: { kind: 'in-place', grant: { project: workDir, ops: ['edit'] } },
      session: { brief: 'none', sources: 'user', env: ['CLAUDE_CONFIG_DIR'] },
    });
    expect(core.envs[0]).toEqual({ CLAUDE_CONFIG_DIR: configDir });
    expect(core.calls[0]!.fields).toMatchObject({ adapter: 'claude' });
    expect(frames(response.body).map((frame) => frame.kind)).toEqual([
      'session',
      'text',
      'tool',
      'usage',
      'done',
    ]);
  });

  it('несобранная, не истёкшая — пустая песочница заводится на месте и разговор идёт', async () => {
    rmSync(sandboxPaths(id).root, { recursive: true, force: true });
    boot({ turn: FAKE_TURN });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sandbox/run',
      payload: { id, prompt: 'как ты отвечаешь без правила?' },
    });

    expect(response.statusCode).toBe(200);
    expect(existsSync(sandboxPaths(id).configDir)).toBe(true);
    expect(frames(response.body).at(-1)).toMatchObject({ kind: 'done' });
  });

  it('отказ ядра — кадр ошибки своим кодом песочницы с причиной ядра дословно', async () => {
    boot({
      estimate: { ok: false, code: 'task-env-missing', message: 'CLAUDE_CONFIG_DIR has no value' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sandbox/run',
      payload: { id, prompt: 'привет' },
    });

    expect(frames(response.body)).toEqual([
      {
        kind: 'error',
        message:
          'Ядро не провело разговор в песочнице: task-env-missing: CLAUDE_CONFIG_DIR has no value',
        messageCode: 'sandbox-core-refused',
        params: { reason: 'task-env-missing: CLAUDE_CONFIG_DIR has no value' },
      },
    ]);
  });

  it('«Стоп» снимает задачу ядра командой cancel с причиной песочницы', async () => {
    boot({ hold: true, turn: FAKE_TURN });

    const running = app.inject({
      method: 'POST',
      url: '/api/sandbox/run',
      payload: { id, prompt: 'долгий вопрос' },
    });
    await waitFor(() => core.calls.some((call) => call.kind === 'launch'), 5000);
    // Ход идёт, пока его не остановят: дождаться, когда маршрут возьмёт сеанс.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stop = await app.inject({ method: 'POST', url: `/api/sandbox/${id}/stop` });
    expect(stop.json()).toEqual({ ok: true });
    await running;
    await waitFor(() => core.calls.some((call) => call.kind === 'cancel'), 5000);
    expect(core.calls.find((call) => call.kind === 'cancel')!.fields).toEqual({
      reason: SANDBOX_STOP_REASON,
    });
  });
});
