import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../../context.ts';
import type { ChatEvent, RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';

/**
 * F-61: поток песочницы идёт клиенту мимо реестра прогонов, и внутренние события
 * (`compact`, `toolResult` — их читают реестр и сторож групп) уходили бы в SSE.
 * Подменён только процесс CLI: он отдаёт события, маршрут — настоящий.
 */
vi.mock('../../domains/chat/ChatRunner/ChatRunner.ts', () => ({
  ChatRun: class {
    async start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
      onEvent({ kind: 'compact', trigger: 'auto', preTokens: 150_000 });
      onEvent({ kind: 'toolResult', toolUseId: 'tool-1', chars: 4_000 });
      onEvent({ kind: 'text', text: 'ответ' });
    }
    stop(): void {}
  },
}));

const { registerSandboxRoutes } = await import('./sandbox-routes.ts');
const { sandboxPaths } = await import('../../domains/sandbox/SandboxConfig.ts');

describe('маршрут прогона песочницы: внутренние события', () => {
  let root: string;
  let app: FastifyInstance;
  const id = `qa-internal-${process.pid}`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-sandbox-internal-'));
    mkdirSync(sandboxPaths(id).configDir, { recursive: true });
    const ctx = {
      location: { paths: { root, appData: join(root, 'agentdeck') } },
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

  it('сжатие окна и результат вызова в поток песочницы не уходят, текст уходит', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sandbox/run',
      payload: { id, prompt: 'вопрос' },
    });
    const kinds = response.body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => (JSON.parse(frame.slice(6)) as ChatEvent).kind);
    expect(kinds).toEqual(['text']);
  });
});
