import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CANON_VERSION } from '@agentdeck/contracts/portable-env';
import type {
  EnvSubscription,
  SubscriptionSyncPlan,
} from '@agentdeck/contracts/portable-subscribe';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { forgetShownPlans } from '../domains/portability/plan.ts';
import { subscriptionKey } from '../domains/portability/subscribe.ts';
import { registerPortabilityRoutes } from './portability-routes.ts';

/**
 * Подписка на уровне маршрутов: подписать, показать, пересобрать, отписать (П5.1).
 *
 * Дом НАСТОЯЩИЙ — временный каталог с живыми файлами панели и цели. Проверяется
 * не «200 в ответе», а порядок и последствия: без показанного плана записи не
 * происходит, пересборка трогает ровно разошедшееся, отписка не трогает ничего.
 */
describe('portability-routes: подписка', () => {
  const HUMAN_TEXT = 'Мой собственный текст, который панель не писала.';
  const savedEnv = { ...process.env };

  let home: string;
  let appData: string;
  let backupDir: string;
  let store: AppStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-subscribe-home-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-subscribe-data-'));
    backupDir = join(appData, 'backups');
    for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.APPDATA = join(home, 'AppData', 'Roaming');
    delete process.env.CLAUDE_CONFIG_DIR;
    forgetShownPlans();

    put(join(home, '.claude', 'CLAUDE.md'), 'Преамбула панели.\n');
    put(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { EDITOR: 'code' }, permissions: { allow: ['Bash(git status)'] } }),
    );
    writeCommand('release', 'Тело выпуска.');
    writeCommand('review', 'Тело ревью.');
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

  function writeCommand(name: string, body: string): void {
    put(
      join(home, '.claude', 'commands', `${name}.md`),
      ['---', `description: Команда ${name}`, '---', '', body, ''].join('\n'),
    );
  }

  const post = (url: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/portability/${url}`, payload: body });

  const target = { target: 'gemini', scope: 'global' };
  const key = subscriptionKey('gemini', 'global');
  const commandFile = (name: string) => join(home, '.gemini', 'commands', `${name}.toml`);

  async function subscribe(layers: string[]): Promise<EnvSubscription> {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/portability/subscription',
      payload: { ...target, layers },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { subscription: EnvSubscription }).subscription;
  }

  async function plan(): Promise<SubscriptionSyncPlan> {
    const res = await post('subscription/plan', target);
    expect(res.statusCode).toBe(200);
    return (res.json() as { plan: SubscriptionSyncPlan }).plan;
  }

  /** Полный круг: показать план и применить его отпечаток. */
  async function resync(): Promise<SubscriptionSyncPlan> {
    const shown = await plan();
    const res = await post('subscription/apply', {
      ...target,
      fingerprint: shown.transfer?.fingerprint,
    });
    expect(res.statusCode).toBe(200);
    return shown;
  }

  it('подписка заводится пустой и слои приходят с проводом', async () => {
    const subscription = await subscribe(['command']);

    expect(subscription.layers).toEqual(['command']);
    expect(subscription.syncedAt).toBeNull();
    expect(subscription.root).toBeNull();

    const list = await app.inject({ method: 'GET', url: '/api/portability/subscriptions' });
    expect((list.json() as { items: EnvSubscription[] }).items).toHaveLength(1);
  });

  it('слой не из словаря — отказ, а не молчаливый пропуск', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/portability/subscription',
      payload: { ...target, layers: ['command', 'выдуманный'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().messageCode).toBe('portability-subscription-layer-unknown');
    expect(store.getPortabilitySubscription(key)).toBeUndefined();
  });

  it('план ничего не пишет, а без него не пишет и пересборка', async () => {
    await subscribe(['command']);
    const shown = await plan();

    expect(shown.rows).toHaveLength(2);
    expect(shown.transfer?.files).toHaveLength(2);
    expect(existsSync(commandFile('release'))).toBe(false);

    const blind = await post('subscription/apply', target);
    expect(blind.statusCode).toBe(409);
    expect(blind.json().messageCode).toBe('portability-plan-not-shown');
    expect(existsSync(commandFile('release'))).toBe(false);
  });

  it('пересборка пишет проекцию и запоминает её запись за записью', async () => {
    await subscribe(['command']);
    await resync();

    expect(readFileSync(commandFile('review'), 'utf8')).toContain('Тело ревью.');
    const stored = store.getPortabilitySubscription(key);
    expect(Object.keys(stored?.marks ?? {})).toHaveLength(2);
    expect(stored?.syncedAt).not.toBeNull();
  });

  it('правка канона пересобирает ровно одну запись', async () => {
    await subscribe(['command']);
    await resync();
    const untouched = readFileSync(commandFile('release'), 'utf8');

    writeCommand('review', 'Тело ревью стало другим.');
    const second = await resync();

    expect(second.rows.filter((row) => row.state === 'changed')).toHaveLength(1);
    expect(second.transfer?.files).toHaveLength(1);
    expect(readFileSync(commandFile('review'), 'utf8')).toContain('стало другим');
    expect(readFileSync(commandFile('release'), 'utf8')).toBe(untouched);
  });

  it('совпавший канон — 200 и ни одного файла, а не отказ', async () => {
    await subscribe(['command']);
    await resync();

    const shown = await plan();
    expect(shown.transfer).toBeNull();
    expect(shown.hold).toBeNull();

    const res = await post('subscription/apply', target);
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.every((row: { state: string }) => row.state === 'unchanged')).toBe(true);
  });

  it('другая версия канона пересобирает проекцию целиком, а не запирает подписку', async () => {
    await subscribe(['command']);
    await resync();
    const projected = readFileSync(commandFile('review'), 'utf8');

    const stored = store.getPortabilitySubscription(key)!;
    store.savePortabilitySubscription(key, { ...stored, canonVersion: CANON_VERSION - 1 });

    // План называет причину и показывает ВСЮ подписку разошедшейся: отпечатки
    // несравнимы, а не совпали.
    const shown = await plan();
    expect(shown.rebuild).toBe('canon_version');
    expect(shown.hold).toBeNull();
    expect(shown.rows.every((row) => row.state !== 'unchanged')).toBe(true);

    // И пересборка проходит: прежде здесь был 409, из которого выхода не было
    // — версию записывает только удачная пересборка.
    const res = await post('subscription/apply', {
      ...target,
      fingerprint: shown.transfer?.fingerprint,
    });
    expect(res.statusCode).toBe(200);
    expect(store.getPortabilitySubscription(key)?.canonVersion).toBe(CANON_VERSION);
    expect(readFileSync(commandFile('review'), 'utf8')).toBe(projected);
    // Следующий круг — обычный: причина ушла, записи снова совпали.
    expect((await plan()).rebuild).toBeNull();
  });

  it('отписка не удаляет у цели ни байта', async () => {
    await subscribe(['command']);
    await resync();
    const before = readFileSync(commandFile('review'), 'utf8');

    await subscribe([]);
    const off = await post('subscription/apply', target);
    expect(off.statusCode).toBe(409);
    expect(off.json().messageCode).toBe('portability-subscription-held');

    const forgotten = await app.inject({
      method: 'DELETE',
      url: '/api/portability/subscription',
      query: target,
    });
    expect(forgotten.statusCode).toBe(200);
    expect(store.getPortabilitySubscription(key)).toBeUndefined();
    // Подписка никогда не владела файлами цели — она обещала их обновлять.
    expect(readFileSync(commandFile('review'), 'utf8')).toBe(before);
  });

  it('файлы подписанной цели попадают в ленту изменений панели', async () => {
    await subscribe(['command']);
    await resync();

    const stored = store.getPortabilitySubscription(key);
    // Лента строится по `trackedFiles`, а тот берёт пути ИЗ ПОДПИСКИ: пересборка
    // чужого CLI видна человеку только так — целью подписки почти никогда не
    // бывает активный провайдер.
    expect(Object.keys(stored?.files ?? {})).toEqual(
      expect.arrayContaining([commandFile('release'), commandFile('review')]),
    );
    expect(stored?.root).not.toBeNull();
  });
});
