import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  SubscriptionDriftPlan,
  SubscriptionSyncPlan,
} from '@agentdeck/contracts/portable-subscribe';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { forgetShownPlans } from '../domains/portability/plan.ts';
import { subscriptionKey } from '../domains/portability/subscribe.ts';
import { registerPortabilityRoutes } from './portability-routes.ts';

/**
 * Человек правил спроецированный файл руками (П5.2).
 *
 * Дом НАСТОЯЩИЙ, и правку вносит настоящая запись в файл цели — проверяется не
 * «маршрут ответил», а то, ЧТО ОСТАЛОСЬ НА ДИСКЕ: удержанный файл обязан
 * остаться байт в байт, а соседний — пересобраться в том же вызове.
 */
describe('portability-routes: расхождения подписки', () => {
  const savedEnv = { ...process.env };

  let home: string;
  let appData: string;
  let backupDir: string;
  let store: AppStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-drift-home-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-drift-data-'));
    backupDir = join(appData, 'backups');
    for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.APPDATA = join(home, 'AppData', 'Roaming');
    delete process.env.CLAUDE_CONFIG_DIR;
    forgetShownPlans();

    put(join(home, '.claude', 'CLAUDE.md'), 'Преамбула панели.\n');
    writeCommand('release', 'Тело выпуска.');
    writeCommand('review', 'Тело ревью.');

    store = new AppStore(appData);
    app = await serve();
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

  async function serve(): Promise<FastifyInstance> {
    const next = Fastify();
    registerPortabilityRoutes(next, { store, backupDir } as unknown as ServerContext);
    await next.ready();
    return next;
  }

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
  const canonFile = (name: string) => join(home, '.claude', 'commands', `${name}.md`);
  const commandFile = (name: string) => join(home, '.gemini', 'commands', `${name}.toml`);
  /** У gemini ВСЕ серверы MCP ложатся в один файл — на нём и проверяется удержание файла. */
  const geminiSettings = () => join(home, '.gemini', 'settings.json');

  function writeMcp(servers: Record<string, { command: string }>): void {
    put(join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }));
  }

  async function subscribe(layers: string[]): Promise<void> {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/portability/subscription',
      payload: { ...target, layers },
    });
    expect(res.statusCode).toBe(200);
  }

  async function plan(): Promise<SubscriptionSyncPlan> {
    const res = await post('subscription/plan', target);
    expect(res.statusCode).toBe(200);
    return (res.json() as { plan: SubscriptionSyncPlan }).plan;
  }

  /** Полный круг пересборки: показать план и применить его отпечаток. */
  async function resync(): Promise<SubscriptionSyncPlan> {
    const shown = await plan();
    const res = await post('subscription/apply', {
      ...target,
      fingerprint: shown.transfer?.fingerprint,
    });
    expect(res.statusCode).toBe(200);
    return shown;
  }

  /** Показать исход и сделать его — тем же отпечатком, что показан. */
  async function settle(resolution: string, filePath: string) {
    const shown = await post('subscription/drift/plan', { ...target, filePath, resolution });
    expect(shown.statusCode).toBe(200);
    const driftPlan = (shown.json() as { plan: SubscriptionDriftPlan }).plan;
    const done = await post('subscription/drift/apply', {
      ...target,
      filePath,
      resolution,
      fingerprint: driftPlan.transfer?.fingerprint,
    });
    return { driftPlan, done };
  }

  /** Подписаться, спроецировать и тронуть один файл цели рукой. */
  async function handEdit(): Promise<string> {
    await subscribe(['command']);
    await resync();
    const touched = `${readFileSync(commandFile('review'), 'utf8')}\n# приписка человека\n`;
    writeFileSync(commandFile('review'), touched, 'utf8');
    return touched;
  }

  it('правка человека держит свой файл, а соседний пересобирается', async () => {
    const touched = await handEdit();

    // Канон двинулся по ОБЕИМ записям: без этого «файл не тронут» доказывало бы
    // лишь то, что пересобирать было нечего.
    writeCommand('review', 'Тело ревью стало другим.');
    writeCommand('release', 'Тело выпуска стало другим.');
    const shown = await resync();

    expect(shown.drift.map((file) => file.filePath)).toEqual([commandFile('review')]);
    expect(shown.drift[0]?.state).toBe('edited');
    expect(shown.drift[0]?.itemIds).toEqual(['command:review']);
    expect(shown.drift[0]?.layers).toEqual(['command']);
    expect(shown.rows.find((row) => row.itemId === 'command:review')?.heldBy).toBe(
      commandFile('review'),
    );
    expect(shown.rows.find((row) => row.itemId === 'command:release')?.heldBy).toBeNull();

    // Главное утверждение П5.2: удержанный файл не тронут ни одним байтом,
    // соседний пересобран тем же вызовом.
    expect(readFileSync(commandFile('review'), 'utf8')).toBe(touched);
    expect(readFileSync(commandFile('release'), 'utf8')).toContain('стало другим');
  });

  it('в тронутый файл не дописывается и НОВАЯ запись', async () => {
    // Слой, у которого все записи ложатся в ОДИН файл цели: у команд файл на
    // запись, и удержание там неотличимо от отбора разошедшихся. Новая запись
    // отметки не имеет, удержать её через отметку нечем — держит файл.
    writeMcp({ alpha: { command: 'a' }, beta: { command: 'b' } });
    await subscribe(['mcpServer']);
    await resync();

    const touched = `${readFileSync(geminiSettings(), 'utf8')}\n`;
    writeFileSync(geminiSettings(), touched, 'utf8');
    writeMcp({ alpha: { command: 'a' }, beta: { command: 'b' }, gamma: { command: 'c' } });

    const shown = await resync();

    expect(shown.rows.find((row) => row.itemId === 'mcpServer:gamma')?.state).toBe('new');
    expect(shown.drift.map((file) => file.filePath)).toEqual([geminiSettings()]);
    expect(shown.transfer).toBeNull();
    expect(readFileSync(geminiSettings(), 'utf8')).toBe(touched);
    expect(store.getPortabilitySubscription(key)!.marks['mcpServer:gamma']).toBeUndefined();
  });

  it('удержанная запись не помечается спроецированной', async () => {
    await handEdit();
    const before = store.getPortabilitySubscription(key)!.marks['command:review']!.fingerprint;

    writeCommand('review', 'Тело ревью стало другим.');
    await resync();

    // Отметка осталась прежней: обнови её панель, расхождение исчезло бы из
    // строк, а правка человека осталась бы на диске — молча и навсегда.
    expect(store.getPortabilitySubscription(key)!.marks['command:review']!.fingerprint).toBe(
      before,
    );
  });

  it('расхождение переживает перезапуск панели', async () => {
    await handEdit();

    // Новое хранилище поверх того же каталога и новый сервер: в памяти процесса
    // не остаётся ничего, и расхождение обязано найтись заново.
    await app.close();
    store = new AppStore(appData);
    app = await serve();
    forgetShownPlans();

    const shown = await plan();
    expect(shown.drift.map((file) => file.filePath)).toEqual([commandFile('review')]);
  });

  it('исход «вернуть проекцию» пересобирает файл, даже когда канон не двигался', async () => {
    const touched = await handEdit();

    const { driftPlan, done } = await settle('projection', commandFile('review'));
    expect(driftPlan.transfer?.files.map((file) => file.filePath)).toEqual([commandFile('review')]);
    expect(done.statusCode).toBe(200);
    expect(done.json().resolution).toBe('projection');

    const after = readFileSync(commandFile('review'), 'utf8');
    expect(after).not.toBe(touched);
    expect(after).toContain('Тело ревью.');
    // Расхождения больше нет: панель снова знает, каким оставила файл.
    expect((await plan()).drift).toEqual([]);
  });

  it('исход «взять в канон» пишет правку человека в файлы канона импортёром', async () => {
    await handEdit();
    writeFileSync(
      commandFile('review'),
      'description = "Команда review"\nprompt = "Человек переписал тело ревью."\n',
      'utf8',
    );

    const { driftPlan, done } = await settle('canon', commandFile('review'));
    // Пишется КАНОН, а не цель: исход разворачивает направление переноса.
    expect(driftPlan.transfer?.target).toBe('claude');
    expect(driftPlan.transfer?.files.map((file) => file.filePath)).toEqual([canonFile('review')]);
    expect(done.statusCode).toBe(200);
    expect(done.json().adopted).toEqual(['command:review']);

    expect(readFileSync(canonFile('review'), 'utf8')).toContain('Человек переписал тело ревью.');
    // Соседняя запись канона не тронута: берутся записи ЭТОГО файла.
    expect(readFileSync(canonFile('release'), 'utf8')).toContain('Тело выпуска.');

    // Ни расхождения, ни пересборки следом: канон согласован с целью, и
    // следующая пересборка не перепишет человеку его же правку.
    const shown = await plan();
    expect(shown.drift).toEqual([]);
    expect(shown.transfer).toBeNull();
  });

  it('исход «отписать» снимает слои файла и забывает его, не тронув байта у цели', async () => {
    const touched = await handEdit();

    const done = await post('subscription/drift/apply', {
      ...target,
      filePath: commandFile('review'),
      resolution: 'unsubscribe',
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().unsubscribed).toEqual(['command']);

    const stored = store.getPortabilitySubscription(key)!;
    expect(stored.layers).toEqual([]);
    expect(stored.files[commandFile('review')]).toBeUndefined();
    // Память о спроецированном остаётся: повторная подписка не объявит новым
    // каждый файл, который панель уже писала.
    expect(stored.marks['command:review']).toBeDefined();
    expect(readFileSync(commandFile('review'), 'utf8')).toBe(touched);
  });

  it('удалённый человеком файл в канон не берётся', async () => {
    await subscribe(['command']);
    await resync();
    rmSync(commandFile('review'));

    const shown = await plan();
    expect(shown.drift.find((file) => file.filePath === commandFile('review'))?.state).toBe(
      'missing',
    );

    const refused = await post('subscription/drift/plan', {
      ...target,
      filePath: commandFile('review'),
      resolution: 'canon',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().messageCode).toBe('portability-drift-file-missing');
    expect(existsSync(commandFile('review'))).toBe(false);
  });

  it('исход по несуществующему расхождению и неизвестный исход — отказы', async () => {
    await subscribe(['command']);
    await resync();

    const absent = await post('subscription/drift/plan', {
      ...target,
      filePath: commandFile('review'),
      resolution: 'projection',
    });
    expect(absent.statusCode).toBe(409);
    expect(absent.json().messageCode).toBe('portability-drift-absent');

    await handEdit();
    const unknown = await post('subscription/drift/plan', {
      ...target,
      filePath: commandFile('review'),
      resolution: 'выдуманный',
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().messageCode).toBe('portability-drift-resolution-unknown');
  });

  it('исход без показанного плана не пишет ничего', async () => {
    const touched = await handEdit();

    const blind = await post('subscription/drift/apply', {
      ...target,
      filePath: commandFile('review'),
      resolution: 'projection',
    });
    expect(blind.statusCode).toBe(409);
    expect(blind.json().messageCode).toBe('portability-plan-not-shown');
    expect(readFileSync(commandFile('review'), 'utf8')).toBe(touched);
  });
});
