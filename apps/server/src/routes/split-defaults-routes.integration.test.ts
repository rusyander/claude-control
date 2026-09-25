import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SplitDefaults, SplitDefaultsView } from '@agentdeck/contracts/split-groups';
import type { SplitSettingsView } from '@agentdeck/contracts/task-split';
import { AppStore } from '../lib/app-store.ts';
import type { SplitPlanRecord } from '../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../context.ts';
import { registerProjectGitRoutes } from './project-git-routes.ts';
import { registerSplitDefaultsRoutes } from './split-defaults-routes.ts';

/**
 * Вкладка «Группы» поверх НАСТОЯЩИХ маршрутов и НАСТОЯЩЕГО хранилища на
 * временном каталоге: вопрос теста — что общие правила сохраняются на диск,
 * проект их наследует, пока не переопределит, границы держит сервер, а старые
 * записи проектов читаются без потерь.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

describe('вкладка «Группы»: общие правила и проект', () => {
  let root: string;
  let appData: string;
  let project: string;
  let app: FastifyInstance;
  let store: AppStore;
  let kicked: string[];

  const boot = async (): Promise<void> => {
    store = new AppStore(appData);
    const ctx = { store, location: { paths: { appData } } } as unknown as ServerContext;
    app = Fastify();
    registerProjectGitRoutes(app, ctx, undefined, (path) => void kicked.push(path));
    registerSplitDefaultsRoutes(app, ctx, (path) => void kicked.push(path));
    await app.ready();
  };

  const defaultsOf = async (): Promise<SplitDefaultsView> =>
    (await app.inject({ method: 'GET', url: '/api/split-defaults' })).json<SplitDefaultsView>();

  const putDefaults = (payload: unknown) =>
    app.inject({ method: 'PUT', url: '/api/split-defaults', payload: payload as object });

  const projectView = async (): Promise<SplitSettingsView> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/project-git/split-settings?path=${encodeURIComponent(project)}`,
      })
    ).json<SplitSettingsView>();

  const putProject = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: '/api/project-git/split-settings',
      payload: { path: project, ...payload },
    });

  const withDefaults = (base: SplitDefaults, patch: Partial<SplitDefaults>): SplitDefaults => ({
    ...structuredClone(base),
    ...patch,
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-split-defaults-'));
    appData = join(root, 'agentdeck');
    project = join(root, 'repo');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project, { recursive: true });
    kicked = [];
    await boot();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(root);
  });

  it('из коробки: 8 лёгких, 4 тяжёлых, правило «больше одной установки или сборка»', async () => {
    const { defaults, builtIn } = await defaultsOf();
    expect(defaults).toEqual(builtIn);
    expect(defaults).toMatchObject({ parallelLight: 8, parallelHeavy: 4 });
    expect(defaults.heavy).toEqual({ chains: 1, steps: 1 });
    // Затирание истории из коробки у человека (аудит 25.09, L163).
    expect(defaults.permissions).toMatchObject({
      routine: 'auto',
      gitWrite: 'auto',
      gitHistory: 'human',
      database: 'human',
    });
    expect(defaults.groupQuestions).toBe('plan');
  });

  it('запись прошлой версии (булевы строки) читается положениями без переписывания', async () => {
    await app.close();
    writeFileSync(
      join(appData, 'state.json'),
      JSON.stringify({ splitDefaults: { permissions: { gitWrite: false, gitHistory: true } } }),
    );
    await boot();
    expect((await defaultsOf()).defaults.permissions).toMatchObject({
      gitWrite: 'human',
      gitHistory: 'auto',
    });
  });

  // Аудит 25.09, L20 и L40: три положения строки и «кто решает развилки».
  it('положения строк и развилки ложатся на диск; чужое положение — 400', async () => {
    const { builtIn } = await defaultsOf();
    const next = withDefaults(builtIn, {
      permissions: { ...builtIn.permissions, gitWrite: 'notify' },
      groupQuestions: 'human',
    });
    const res = await putDefaults(next);
    expect(res.statusCode).toBe(200);
    expect((await defaultsOf()).defaults).toMatchObject({
      permissions: { gitWrite: 'notify' },
      groupQuestions: 'human',
    });

    for (const bad of [
      { ...next, permissions: { ...next.permissions, gitWrite: 'sometimes' } },
      { ...next, groupQuestions: 'ask' },
    ]) {
      expect((await putDefaults(bad as SplitDefaults)).statusCode).toBe(400);
    }
    expect((await defaultsOf()).defaults).toEqual(next);
  });

  it('границы держит сервер: 0, 31 и порог 21 — 400, запись не тронута, очередь не толкнута', async () => {
    const { builtIn } = await defaultsOf();
    for (const bad of [
      withDefaults(builtIn, { parallelLight: 0 }),
      withDefaults(builtIn, { parallelHeavy: 31 }),
      withDefaults(builtIn, { heavy: { chains: 21, steps: 1 } }),
      withDefaults(builtIn, { parallelLight: 2.5 }),
    ]) {
      const res = await putDefaults(bad);
      expect(res.statusCode).toBe(400);
    }
    expect((await defaultsOf()).defaults).toEqual(builtIn);
    expect(kicked).toEqual([]);
  });

  it('общие правила ложатся на диск и толкают очередь каждого проекта с разделением', async () => {
    store.setSplitPlan({ parentChatId: 'p1', projectPath: project } as unknown as SplitPlanRecord);
    const { builtIn } = await defaultsOf();
    const next = withDefaults(builtIn, {
      parallelLight: 5,
      parallelHeavy: 2,
      heavy: { chains: 2, steps: 1 },
      permissions: { ...builtIn.permissions, gitWrite: 'human' },
    });
    const res = await putDefaults(next);
    expect(res.statusCode).toBe(200);
    expect(res.json<SplitDefaultsView>().defaults).toEqual(next);
    expect(kicked).toEqual([project]);

    // На диске — только отклонение от коробки.
    const saved = JSON.parse(readFileSync(join(appData, 'state.json'), 'utf8')) as {
      splitDefaults?: unknown;
    };
    expect(saved.splitDefaults).toEqual({
      permissions: { gitWrite: 'human' },
      parallelLight: 5,
      parallelHeavy: 2,
      heavy: { chains: 2 },
    });

    // Перезапуск панели читает то же.
    await app.close();
    await boot();
    expect((await defaultsOf()).defaults).toEqual(next);
  });

  it('проект наследует общий потолок по тяжести, пока его не закрепили; сброс возвращает общий', async () => {
    const { builtIn } = await defaultsOf();
    await putDefaults(withDefaults(builtIn, { parallelLight: 6, parallelHeavy: 3 }));
    expect(await projectView()).toMatchObject({ parallel: 6, parallelAuto: true });

    // Две установки — тяжёлый по правилу из коробки.
    for (const name of ['a', 'b']) {
      mkdirSync(join(project, name));
      writeFileSync(join(project, name, 'package-lock.json'), '{}');
    }
    const heavy = await projectView();
    expect(heavy.profile.heavy).toBe(true);
    expect(heavy).toMatchObject({ parallel: 3, parallelAuto: true });

    // Правило тяжести поднято до двух установок — тот же проект лёгкий.
    await putDefaults(
      withDefaults(builtIn, { parallelLight: 6, parallelHeavy: 3, heavy: { chains: 2, steps: 1 } }),
    );
    const relaxed = await projectView();
    expect(relaxed.profile.heavy).toBe(false);
    expect(relaxed.parallel).toBe(6);

    expect((await putProject({ deliver: true, parallel: 11 })).statusCode).toBe(200);
    expect(await projectView()).toMatchObject({ parallel: 11, parallelAuto: false });
    await putDefaults(withDefaults(builtIn, { parallelLight: 9, heavy: { chains: 2, steps: 1 } }));
    expect((await projectView()).parallel).toBe(11);

    await putProject({ deliver: true, parallel: null });
    expect(await projectView()).toMatchObject({ parallel: 9, parallelAuto: true });
  });

  it('строки разрешений: своё поверх общего, «До MR» их не стирает, null сбрасывает к общим', async () => {
    const { builtIn } = await defaultsOf();
    const put = await putProject({
      deliver: true,
      parallel: null,
      permissions: { gitWrite: 'human', bogus: true },
    });
    expect(put.statusCode).toBe(200);
    const own = await projectView();
    expect(own.permissions.gitWrite).toBe('human');
    expect(own.permissionsOwn).toEqual(['gitWrite']);

    // Общая строка сменилась — непереопределённая следует, своя держится.
    await putDefaults(
      withDefaults(builtIn, {
        permissions: { ...builtIn.permissions, gitWrite: 'auto', externalWrite: 'human' },
      }),
    );
    const inherited = await projectView();
    expect(inherited.permissions).toMatchObject({ gitWrite: 'human', externalWrite: 'human' });

    // Тумблер «До MR» в шапке чата шлёт только доставку и число.
    await putProject({ deliver: false, parallel: 2 });
    expect((await projectView()).permissionsOwn).toEqual(['gitWrite']);

    await putProject({ deliver: false, parallel: 2, permissions: null });
    const reset = await projectView();
    expect(reset.permissionsOwn).toEqual([]);
    expect(reset.permissions.gitWrite).toBe('auto');
  });

  it('старая запись проекта (доставка + число) читается без потерь и наследует разрешения', async () => {
    await app.close();
    const key = project.replace(/\\/g, '/').replace(/\/+$/, '');
    const legacy = {
      splitSettings: {
        [process.platform === 'win32' ? key.toLowerCase() : key]: { deliver: false, parallel: 3 },
      },
    };
    writeFileSync(join(appData, 'state.json'), JSON.stringify(legacy), 'utf8');
    await boot();
    const view = await projectView();
    expect(view).toMatchObject({ deliver: false, parallel: 3, parallelAuto: false });
    expect(view.permissionsOwn).toEqual([]);
    expect(view.permissions).toEqual((await defaultsOf()).defaults.permissions);
  });
});
