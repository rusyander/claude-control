import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import type { ProviderKeysResponse, ProviderRunnerInfo } from '@claude-control/contracts';
import { registerProviderKeysRoutes } from './provider-keys-routes.ts';

/**
 * Роуты API-ключей провайдеров и резолвинга раннера (Ф6a). appData — изолированный
 * tmp-каталог (не настоящий ~). Проверяем: список статусов маскирован, PUT/DELETE
 * не эхоят секрет, файл на диске зашифрован, provider-runner отдаёт режим.
 */
function makeCtx(root: string, provider: string): ServerContext {
  const appData = join(root, 'claude-control');
  mkdirSync(appData, { recursive: true });
  const store = new AppStore(appData);
  if (provider !== 'claude') store.updateSettings({ provider });
  return {
    location: { paths: { root, appData } },
    store,
    backupDir: join(appData, 'backups'),
  } as unknown as ServerContext;
}

describe('provider-keys роуты', () => {
  let root: string;
  let app: FastifyInstance;

  const boot = async (provider: string): Promise<void> => {
    app = Fastify();
    registerProviderKeysRoutes(app, makeCtx(root, provider));
    await app.ready();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-keys-route-'));
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
  });

  it('GET /api/provider-keys → 200, все провайдеры, статусы без секретов', async () => {
    await boot('codex');
    const res = await app.inject({ method: 'GET', url: '/api/provider-keys' });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProviderKeysResponse>();
    expect(body.active).toBe('codex');
    const codex = body.items.find((i) => i.providerId === 'codex');
    expect(codex?.supported).toBe(true);
    expect(codex?.keyStatus.present).toBe(false);
    const cursor = body.items.find((i) => i.providerId === 'cursor');
    expect(cursor?.supported).toBe(false);
  });

  it('PUT задаёт ключ, ответ маскирован (секрет НЕ эхоится), файл зашифрован', async () => {
    await boot('codex');
    const SECRET = 'sk-route-SUPERSECRET-9999';
    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-keys/codex',
      payload: { key: SECRET },
    });
    expect(res.statusCode).toBe(200);
    // Ответ не содержит открытого ключа.
    expect(res.body).not.toContain(SECRET);
    const body = res.json<{ ok: boolean; keyStatus: { source: string; masked: string } }>();
    expect(body.ok).toBe(true);
    expect(body.keyStatus.source).toBe('stored');
    expect(body.keyStatus.masked).not.toContain('SUPERSECRET');

    // Файл на диске зашифрован — открытого ключа нет.
    const encPath = join(root, 'claude-control', 'provider-keys.enc');
    expect(existsSync(encPath)).toBe(true);
    expect(readFileSync(encPath).toString('latin1')).not.toContain(SECRET);

    // GET теперь показывает stored-статус (маску), но не сам ключ.
    const get = await app.inject({ method: 'GET', url: '/api/provider-keys' });
    expect(get.body).not.toContain(SECRET);
    const item = get.json<ProviderKeysResponse>().items.find((i) => i.providerId === 'codex');
    expect(item?.keyStatus.source).toBe('stored');
  });

  it('DELETE очищает ключ', async () => {
    await boot('codex');
    await app.inject({
      method: 'PUT',
      url: '/api/provider-keys/codex',
      payload: { key: 'sk-route-abcdef123' },
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/provider-keys/codex' });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ keyStatus: { present: boolean } }>().keyStatus.present).toBe(false);
  });

  it('PUT для cursor (apiKind none) → 400 unsupported_provider', async () => {
    await boot('cursor');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-keys/cursor',
      payload: { key: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('unsupported_provider');
  });

  it('PUT для неизвестного провайдера → 404 unknown_provider', async () => {
    await boot('codex');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/provider-keys/nope',
      payload: { key: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('unknown_provider');
  });

  it('GET /api/provider-runner → 200, режим none (нет ключа), активный провайдер', async () => {
    await boot('codex');
    const res = await app.inject({ method: 'GET', url: '/api/provider-runner' });
    expect(res.statusCode).toBe(200);
    const body = res.json<ProviderRunnerInfo>();
    expect(body.providerId).toBe('codex');
    expect(['none', 'cli']).toContain(body.mode);
    expect(body.keyStatus.present).toBe(false);
  });

  it('после PUT provider-runner → api (ключ есть)', async () => {
    await boot('codex');
    await app.inject({
      method: 'PUT',
      url: '/api/provider-keys/codex',
      payload: { key: 'sk-route-abcdef123' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/provider-runner' });
    const body = res.json<ProviderRunnerInfo>();
    expect(body.mode).toBe('api');
    expect(body.reason).toBe('api_key');
  });
});
