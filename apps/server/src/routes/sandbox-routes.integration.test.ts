import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../context.ts';
import { sandboxPaths, sweepIdleSandboxes } from '../domains/sandbox/SandboxConfig.ts';
import { registerSandboxRoutes } from './sandbox-routes.ts';

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
      location: { paths: { root, appData: join(root, 'claude-control') } },
      store: {},
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
});
