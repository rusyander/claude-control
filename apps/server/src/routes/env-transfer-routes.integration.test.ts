import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerEnvTransferRoutes } from './env-transfer-routes.ts';

/**
 * Маршруты переноса окружения от начала до конца: посмотреть, что уедет →
 * собрать архив в выбранную папку → построить план разворота → применить
 * отмеченное. Проверяются и отказы: неизвестный провайдер, несуществующая
 * папка, чужой файл вместо архива, пустой выбор.
 */
function makeCtx(root: string): ServerContext {
  const appData = join(root, 'claude-control');
  mkdirSync(appData, { recursive: true });
  return {
    location: { paths: { root, appData } },
    store: new AppStore(appData),
    backupDir: join(appData, 'backups'),
  } as unknown as ServerContext;
}

describe('env-transfer роуты', () => {
  let root: string;
  let kimiHome: string;
  let outDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-env-route-'));
    kimiHome = join(root, 'kimi');
    outDir = join(root, 'вывод');
    mkdirSync(kimiHome, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    process.env.KIMI_CODE_HOME = kimiHome;

    writeFileSync(join(kimiHome, 'AGENTS.md'), '# правила\n', 'utf8');
    writeFileSync(
      join(kimiHome, 'config.toml'),
      'default_permission_mode = "auto"\napi_key = "sk-секрет"\n',
      'utf8',
    );

    app = Fastify();
    registerEnvTransferRoutes(app, makeCtx(root));
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    delete process.env.KIMI_CODE_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  const exportArchive = async (): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/env-transfer/export',
      payload: { provider: 'kimi', targetDir: outDir },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ path: string }>().path;
  };

  it('preview показывает объём, места и чек-лист до сборки архива', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/env-transfer/preview?provider=kimi' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      files: number;
      bytes: number;
      locations: { path: string; exists: boolean }[];
      checklist: { keys: string[] }[];
    }>();
    expect(body.files).toBe(2);
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.locations[0]?.path).toBe(kimiHome);
    expect(body.locations[0]?.exists).toBe(true);
    expect(body.checklist.flatMap((item) => item.keys)).toContain('api_key');
  });

  it('экспорт кладёт архив в выбранную папку и возвращает путь к нему', async () => {
    const path = await exportArchive();

    expect(path.startsWith(outDir)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(path.endsWith('.zip')).toBe(true);
    // Секрет в архив не уехал.
    expect(readFileSync(path).toString('latin1')).not.toContain('sk-секрет');
  });

  it('второй экспорт в ту же папку не затирает первый архив', async () => {
    const first = await exportArchive();
    const second = await exportArchive();
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
  });

  it('план и применение: пишется только отмеченное, остальное остаётся как было', async () => {
    const archivePath = await exportArchive();

    // «Новая машина»: тот же провайдер, но пустая конфигурация.
    const fresh = join(root, 'kimi-new');
    mkdirSync(fresh, { recursive: true });
    process.env.KIMI_CODE_HOME = fresh;

    const planRes = await app.inject({
      method: 'POST',
      url: '/api/env-transfer/import/plan',
      payload: { provider: 'kimi', archivePath },
    });
    expect(planRes.statusCode).toBe(200);
    const plan = planRes.json<{
      counts: { new: number };
      entries: { archivePath: string; relative: string; status: string }[];
    }>();
    expect(plan.counts.new).toBe(2);

    const agents = plan.entries.find((entry) => entry.relative === 'AGENTS.md')!;
    const applyRes = await app.inject({
      method: 'POST',
      url: '/api/env-transfer/import/apply',
      payload: { provider: 'kimi', archivePath, selection: [agents.archivePath] },
    });
    expect(applyRes.statusCode).toBe(200);
    expect(applyRes.json<{ ok: boolean }>().ok).toBe(true);

    expect(readFileSync(join(fresh, 'AGENTS.md'), 'utf8')).toBe('# правила\n');
    expect(existsSync(join(fresh, 'config.toml'))).toBe(false);
  });

  it('отказы: неизвестный провайдер, чужая папка, не архив, пустой выбор', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/env-transfer/preview?provider=неизвестный',
    });
    expect(unknown.statusCode).toBe(400);

    const badDir = await app.inject({
      method: 'POST',
      url: '/api/env-transfer/export',
      payload: { provider: 'kimi', targetDir: join(root, 'нет-такой-папки') },
    });
    expect(badDir.statusCode).toBe(400);

    const notArchive = join(root, 'просто.zip');
    writeFileSync(notArchive, 'это не архив', 'utf8');
    const broken = await app.inject({
      method: 'POST',
      url: '/api/env-transfer/import/plan',
      payload: { provider: 'kimi', archivePath: notArchive },
    });
    expect(broken.statusCode).toBe(400);

    const archivePath = await exportArchive();
    const empty = await app.inject({
      method: 'POST',
      url: '/api/env-transfer/import/apply',
      payload: { provider: 'kimi', archivePath, selection: [] },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('архив kimi не разворачивается в другого провайдера', async () => {
    const archivePath = await exportArchive();
    const res = await app.inject({
      method: 'POST',
      url: '/api/env-transfer/import/plan',
      payload: { provider: 'codex', archivePath },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/собран для/);
  });
});
