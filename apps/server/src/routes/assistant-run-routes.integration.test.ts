import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { ModelCatalogStore } from '../domains/models/model-store.ts';
import type { ServerContext } from '../context.ts';
import type { AssistantRunResult } from '@claude-control/contracts';
import { registerAssistantRoutes } from './assistant-routes.ts';

/**
 * Роут `POST /api/assistant/run` (Ф6b). Проверяем структуру ответа без реальной
 * сети/spawn: cursor всегда резолвится в `none/unsupported` — раннеры не
 * вызываются, поэтому тест детерминирован и безопасен.
 */
function makeCtx(root: string, provider: string): ServerContext {
  const appData = join(root, 'claude-control');
  mkdirSync(appData, { recursive: true });
  const store = new AppStore(appData);
  if (provider !== 'claude') store.updateSettings({ provider });
  return {
    location: { paths: { root, appData } },
    store,
    // Каталог моделей пуст и в сеть не ходит: ассистент читает только кэш, а его
    // здесь нет — значит, останется на зашитой модели, как и задумано.
    models: new ModelCatalogStore(appData),
    backupDir: join(appData, 'backups'),
  } as unknown as ServerContext;
}

describe('POST /api/assistant/run', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-run-route-'));
  });
  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('cursor (unsupported) → 200, ok=false, mode none, вызова модели нет', async () => {
    app = Fastify();
    registerAssistantRoutes(app, makeCtx(root, 'cursor'));
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/assistant/run',
      payload: { messages: [{ role: 'user', content: 'привет' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<AssistantRunResult>();
    expect(body.ok).toBe(false);
    expect(body.mode).toBe('none');
    expect(body.reason).toBe('unsupported');
    expect(body.providerId).toBe('cursor');
  });
});
