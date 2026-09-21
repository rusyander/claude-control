import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TransferPlan } from '@agentdeck/contracts/portable-transfer';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { forgetShownPlans } from '../domains/portability/plan.ts';
import { transferRecordKey } from '../lib/app-store/portability-transfer.ts';
import { registerPortabilityRoutes } from './portability-routes.ts';

/**
 * Перенос на уровне маршрутов: показать, применить, отменить (П2.3).
 *
 * Дом здесь НАСТОЯЩИЙ — временный каталог с живыми файлами источника и цели, —
 * и маршруты ходят по нему тем же кодом, каким ходят по домашнему каталогу на
 * машине. Главное, что проверяется, не «200 в ответе», а порядок: без
 * предшествующего показа записи не происходит вовсе, а после неё есть чем
 * вернуться.
 */
describe('portability-routes: перенос', () => {
  const HUMAN_TEXT = 'Мой собственный текст, который панель не писала.';
  const savedEnv = { ...process.env };

  let home: string;
  let appData: string;
  let backupDir: string;
  let store: AppStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-transfer-home-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-transfer-data-'));
    backupDir = join(appData, 'backups');
    for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.APPDATA = join(home, 'AppData', 'Roaming');
    delete process.env.CLAUDE_CONFIG_DIR;
    forgetShownPlans();

    put(join(home, '.claude', 'CLAUDE.md'), 'Преамбула источника.\n');
    put(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { EDITOR: 'code' }, permissions: { allow: ['Bash(git status)'] } }),
    );
    put(join(home, '.gemini', 'GEMINI.md'), `${HUMAN_TEXT}\n`);

    store = new AppStore(appData);
    app = Fastify();
    registerPortabilityRoutes(app, { store, backupDir } as unknown as ServerContext);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(appData, { recursive: true, force: true });
  });

  function put(path: string, text: string): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, 'utf8');
  }

  const post = (url: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/portability/${url}`, payload: body });

  const get = (url: string, query: Record<string, string>) =>
    app.inject({ method: 'GET', url: `/api/portability/${url}`, query });

  const target = { provider: 'claude', target: 'gemini' };

  async function planned(): Promise<TransferPlan> {
    const res = await post('plan', target);
    expect(res.statusCode).toBe(200);
    return res.json() as TransferPlan;
  }

  it('план показывает файлы и не пишет ни одного', async () => {
    const before = readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8');
    const plan = await planned();

    expect(plan.target).toBe('gemini');
    expect(plan.fingerprint).toHaveLength(64);
    expect(plan.files.length).toBeGreaterThan(0);
    expect(plan.report.rows.length).toBeGreaterThan(0);
    expect(readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8')).toBe(before);
    expect(existsSync(backupDir)).toBe(false);
  });

  it('цели без эмиттера план не строится', async () => {
    const res = await post('plan', { provider: 'claude', target: 'одиннадцатый' });

    expect(res.statusCode).toBe(400);
    expect(res.json().messageCode).toBe('portability-target-unknown');
  });

  it('применение без предшествующего показа — 409 и ни одной записи', async () => {
    const before = readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8');

    const res = await post('apply', target);

    expect(res.statusCode).toBe(409);
    expect(res.json().messageCode).toBe('portability-plan-not-shown');
    expect(readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8')).toBe(before);
  });

  it('придуманный отпечаток — тот же отказ: показа не было', async () => {
    await planned();

    const res = await post('apply', { ...target, fingerprint: 'a'.repeat(64) });

    expect(res.statusCode).toBe(409);
    expect(res.json().messageCode).toBe('portability-plan-not-shown');
  });

  it('файлы изменились после показа — 409 и свежий план тем же ответом', async () => {
    const plan = await planned();
    put(join(home, '.gemini', 'GEMINI.md'), `${HUMAN_TEXT}\nчеловек дописал строку\n`);

    const res = await post('apply', { ...target, fingerprint: plan.fingerprint });

    expect(res.statusCode).toBe(409);
    expect(res.json().messageCode).toBe('portability-plan-stale');
    const fresh = res.json().plan as TransferPlan;
    expect(fresh.fingerprint).not.toBe(plan.fingerprint);
  });

  it('копии выключены — перенос не начинается', async () => {
    const withoutBackups = Fastify();
    registerPortabilityRoutes(withoutBackups, { store } as unknown as ServerContext);
    await withoutBackups.ready();
    const plan = (
      await withoutBackups.inject({
        method: 'POST',
        url: '/api/portability/plan',
        payload: target,
      })
    ).json() as TransferPlan;

    const res = await withoutBackups.inject({
      method: 'POST',
      url: '/api/portability/apply',
      payload: { ...target, fingerprint: plan.fingerprint },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().messageCode).toBe('portability-backups-off');
    expect(readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8')).toBe(`${HUMAN_TEXT}\n`);
    await withoutBackups.close();
  });

  it('показ, применение и отмена возвращают файлы к состоянию до переноса', async () => {
    const before = readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8');
    const plan = await planned();

    const applied = await post('apply', { ...target, fingerprint: plan.fingerprint });
    expect(applied.statusCode).toBe(200);
    const record = applied.json().record;
    expect(record.files.length).toBeGreaterThan(0);
    expect(readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8')).not.toBe(before);
    // След лежит в состоянии панели: без него кнопки отмены не существует.
    expect(store.getPortabilityTransfer(transferRecordKey('claude', 'gemini', 'global'))).toEqual(
      record,
    );

    const reverted = await post('revert', target);

    expect(reverted.statusCode).toBe(200);
    expect(reverted.json().changedSince).toEqual([]);
    expect(reverted.json().record).toBeNull();
    expect(readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8')).toBe(before);
    expect(
      store.getPortabilityTransfer(transferRecordKey('claude', 'gemini', 'global')),
    ).toBeUndefined();
  });

  it('повторное применение того же отпечатка — 409: файлы уже другие', async () => {
    const plan = await planned();
    expect((await post('apply', { ...target, fingerprint: plan.fingerprint })).statusCode).toBe(
      200,
    );

    const again = await post('apply', { ...target, fingerprint: plan.fingerprint });

    expect(again.statusCode).toBe(409);
    expect(again.json().messageCode).toBe('portability-plan-stale');
  });

  it('отменять нечего — 404, а не молчаливое «готово»', async () => {
    const res = await post('revert', target);

    expect(res.statusCode).toBe(404);
    expect(res.json().messageCode).toBe('portability-transfer-not-found');
  });

  it('следа нет — 200 и пустой ответ: экран открывается без кнопки отмены, а не с ошибкой', async () => {
    const res = await get('transfer', target);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ record: null, changedSince: [] });
  });

  it('след переносит перезагрузку страницы: после применения его отдаёт чтение, а не память вкладки', async () => {
    const plan = await planned();
    const applied = await post('apply', { ...target, fingerprint: plan.fingerprint });
    expect(applied.statusCode).toBe(200);

    const res = await get('transfer', target);

    expect(res.statusCode).toBe(200);
    // Ровно тот же след, что вернуло применение: второй формы записи о переносе
    // в панели нет, и экран после F5 читает то же самое.
    expect(res.json().record).toEqual(applied.json().record);
    expect(res.json().changedSince).toEqual([]);
  });

  it('файл, изменённый после переноса, назван ДО нажатия отмены', async () => {
    const plan = await planned();
    expect((await post('apply', { ...target, fingerprint: plan.fingerprint })).statusCode).toBe(
      200,
    );
    const touched = join(home, '.gemini', 'GEMINI.md');
    writeFileSync(
      touched,
      `${readFileSync(touched, 'utf8')}\nДописано человеком после переноса.\n`,
    );

    const res = await get('transfer', target);

    // Цена решения известна заранее: человек видит, что отмена не тронет этот
    // файл, ещё до того, как решится нажать.
    expect(res.json().changedSince).toEqual([touched]);
    expect(res.json().record.files.length).toBeGreaterThan(0);
  });

  it('чтение следа ничего не пишет: цель и состояние панели после него те же', async () => {
    const plan = await planned();
    expect((await post('apply', { ...target, fingerprint: plan.fingerprint })).statusCode).toBe(
      200,
    );
    const key = transferRecordKey('claude', 'gemini', 'global');
    const before = readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8');
    const record = store.getPortabilityTransfer(key);

    await get('transfer', target);

    expect(readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8')).toBe(before);
    expect(store.getPortabilityTransfer(key)).toEqual(record);
  });
});
