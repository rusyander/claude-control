import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../context.ts';
import type { RunOptions } from '../domains/chat/ChatRunner.ts';

/**
 * Песочница сама просит `--setting-sources user`.
 *
 * Сужение источников раньше выводилось из одного `configDir`, и любой прогон со
 * своим каталогом конфигурации терял слои проекта. Теперь флаг — явная просьба
 * маршрута песочницы; этот тест держит, что просьба не потеряется.
 */
const started: RunOptions[] = [];

vi.mock('../domains/chat/ChatRunner.ts', () => ({
  ChatRun: class {
    async start(options: RunOptions): Promise<void> {
      started.push(options);
    }
    stop(): void {}
  },
}));

const { registerSandboxRoutes } = await import('./sandbox-routes.ts');
const { sandboxPaths } = await import('../domains/sandbox/SandboxConfig.ts');

describe('маршрут прогона песочницы: источники настроек', () => {
  let root: string;
  let app: FastifyInstance;
  const id = `qa-sources-${process.pid}`;

  beforeEach(() => {
    started.length = 0;
    root = mkdtempSync(join(tmpdir(), 'cc-sandbox-sources-'));
    mkdirSync(sandboxPaths(id).configDir, { recursive: true });
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

  it('прогон песочницы уходит со своим каталогом и `settingSources: user`', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sandbox/run',
      payload: { id, prompt: 'вопрос' },
    });

    expect(started).toHaveLength(1);
    expect(started[0]?.configDir).toBe(sandboxPaths(id).configDir);
    expect(started[0]?.settingSources).toBe('user');
  });
});
