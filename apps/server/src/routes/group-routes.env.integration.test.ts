import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerGroupRoutes } from './group-routes.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * Переменные окружения групп и краевые случаи логики групп на живом Fastify с
 * настоящими доменами и временным каталогом. Основной фокус — модель envByGroup:
 * общий ключ двух групп снимается только когда его отпустили обе; удаление
 * группы уносит её ключи. Плюс регрессии и два вскрытых бага (помечены skip).
 */
describe('маршруты групп: переменные окружения и краевые случаи', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  const settingsPath = (): string => join(root, 'settings.json');

  const makeCtx = (): ServerContext =>
    ({
      location: {
        paths: {
          root,
          settings: settingsPath(),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
        },
      },
      store,
      backupDir: join(root, 'claude-control', 'backups'),
    }) as unknown as ServerContext;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-env-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify({}), 'utf8');
    writeFileSync(join(root, 'CLAUDE.md'), '# Правила\n', 'utf8');

    store = new AppStore(join(root, 'claude-control'));

    app = Fastify();
    registerGroupRoutes(app, makeCtx());
    registerEntityRoutes(app, makeCtx());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const createGroup = async (payload: Record<string, unknown>): Promise<string> => {
    const res = await app.inject({ method: 'POST', url: '/api/groups', payload });
    return res.json<{ id: string }>().id;
  };

  const putGroup = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/groups/${id}`, payload });

  const toggle = (id: string, isEnabled: boolean) =>
    app.inject({ method: 'POST', url: `/api/groups/${id}/enabled`, payload: { isEnabled } });

  const readEnv = (): Record<string, string> =>
    (JSON.parse(readFileSync(settingsPath(), 'utf8')) as { env?: Record<string, string> }).env ??
    {};

  const readGroups = async () =>
    (await app.inject({ method: 'GET', url: '/api/groups' })).json<
      { id: string; order: number }[]
    >();

  it('общий ключ двух групп остаётся, пока его держит хотя бы одна', async () => {
    const g1 = await createGroup({ name: 'g1', members: [] });
    const g2 = await createGroup({ name: 'g2', members: [] });

    await putGroup(g1, {
      name: 'g1',
      members: [],
      env: { SHARED: 'v1', OWN1: 'x' },
      isEnabled: true,
    });
    await putGroup(g2, {
      name: 'g2',
      members: [],
      env: { SHARED: 'v2', OWN2: 'y' },
      isEnabled: true,
    });

    // Обе применены: общий ключ + по своему у каждой.
    expect(readEnv().SHARED).toBeDefined();
    expect(readEnv().OWN1).toBe('x');
    expect(readEnv().OWN2).toBe('y');

    // Выключаем первую: общий ключ держит вторая — он остаётся, свой уходит.
    await toggle(g1, false);
    expect(readEnv().SHARED).toBeDefined();
    expect(readEnv().OWN1).toBeUndefined();
    expect(readEnv().OWN2).toBe('y');

    // Выключаем вторую: общий больше никто не держит — снимается.
    await toggle(g2, false);
    expect(readEnv().SHARED).toBeUndefined();
    expect(readEnv().OWN2).toBeUndefined();
  });

  it('удаление ВКЛЮЧЁННОЙ группы уносит её env-ключи (кроме общих с другой)', async () => {
    const g1 = await createGroup({ name: 'g1', members: [] });
    const g2 = await createGroup({ name: 'g2', members: [] });
    await putGroup(g1, {
      name: 'g1',
      members: [],
      env: { SHARED: 'a', ONLY1: 'b' },
      isEnabled: true,
    });
    await putGroup(g2, { name: 'g2', members: [], env: { SHARED: 'a' }, isEnabled: true });

    await app.inject({ method: 'DELETE', url: `/api/groups/${g1}` });

    // Свой ключ удалён, общий с g2 — остался.
    expect(readEnv().ONLY1).toBeUndefined();
    expect(readEnv().SHARED).toBeDefined();
  });

  it('ручной env-ключ группа не трогает при выключении', async () => {
    // Ручной ключ уже в settings.json, ничьей группой не помечен.
    writeFileSync(settingsPath(), JSON.stringify({ env: { MANUAL: 'keep' } }), 'utf8');

    const g = await createGroup({ name: 'g', members: [] });
    await putGroup(g, {
      name: 'g',
      members: [],
      env: { MANUAL: 'group', OWN: 'x' },
      isEnabled: true,
    });

    // Ручной не перезаписан значением группы, свой добавлен.
    expect(readEnv().MANUAL).toBe('keep');
    expect(readEnv().OWN).toBe('x');

    await toggle(g, false);
    // Ручной пережил выключение, свой снят.
    expect(readEnv().MANUAL).toBe('keep');
    expect(readEnv().OWN).toBeUndefined();
  });

  it('повторный PUT без изменения env не переписывает settings.json заново', async () => {
    const backupDir = join(root, 'claude-control', 'backups');
    const bakCount = (): number =>
      existsSync(backupDir) ? readdirSync(backupDir).filter((n) => n.endsWith('.bak')).length : 0;

    const g = await createGroup({ name: 'g', members: [] });
    // Первая правка реально применяет env — это ожидаемо.
    await putGroup(g, { name: 'g', members: [], env: { A: '1' }, isEnabled: true });
    expect(readEnv().A).toBe('1');

    const before = bakCount();
    // Правим только имя, env тот же — переприменять нечего, лишней перезаписи
    // settings.json (и лишнего бэкапа) быть не должно.
    await putGroup(g, { name: 'g-переименована', members: [], env: { A: '1' }, isEnabled: true });

    expect(bakCount()).toBe(before);
    // При этом переменная на месте — наблюдаемое состояние не изменилось.
    expect(readEnv().A).toBe('1');
  });

  it('регрессия: правка группы не сбрасывает её порядок (order) в 0', async () => {
    const g1 = await createGroup({ name: 'g1', members: [] });
    await createGroup({ name: 'g2', members: [] });
    const g3 = await createGroup({ name: 'g3', members: [] });

    // Клиент шлёт GroupDraft без order. Раньше сервер ставил order=0 и группа
    // прыгала в начало списка.
    await putGroup(g3, { name: 'g3-переименована', members: [] });

    const groups = await readGroups();
    const g3After = groups.find((item) => item.id === g3);
    expect(g3After?.order).toBe(2);
    // Порядок в выдаче сохранён: g1 по-прежнему первый, g3 — последний.
    expect(groups[0]?.id).toBe(g1);
    expect(groups.at(-1)?.id).toBe(g3);
  });

  /**
   * Право может быть участником группы: `entityRefSchema` включает `permission`,
   * `readPermissions` отдаёт для прав `groupIds`, а состав группы приходит ещё и
   * из `importState`, мимо интерфейса. Когда-то `applyEntityState` ветки для
   * права не имел и выключение группы ставило только отметку `disabledByGroup`,
   * не трогая `settings.json`; ветка давно на месте (`entity-toggle.ts`), и этот
   * тест держит её: погашенное группой право уходит из активного списка решения.
   */
  it('выключение группы с правом-участником снимает право из settings.json', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] } }),
      'utf8',
    );

    const g = await createGroup({
      name: 'g',
      members: [{ kind: 'permission', id: 'deny:Bash(rm:*)' }],
    });

    await toggle(g, false);

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      permissions?: { deny?: string[] };
    };
    // Ожидание: правило погашено группой — его нет в активном deny-списке.
    expect(settings.permissions?.deny ?? []).not.toContain('Bash(rm:*)');
  });

  /**
   * НАХОДКА (major): PUT группы не сверяет состав участников с отметками
   * disabledByGroup. Если выключить группу (участники погашены её отметкой), а
   * затем убрать участника через правку состава, отметка «погашен этой группой»
   * остаётся висеть навсегда: участник заперт в выключенном состоянии без
   * видимой причины (getGroupIdsFor его уже не вернёт — метки группы на нём нет).
   *
   * Тест ждёт, что убранный из выключенной группы участник оживает. Сейчас нет.
   * Снять skip после реконсиляции disabledByGroup в обработчике PUT.
   */
  it('БАГ: убранный из выключенной группы участник должен ожить', async () => {
    // Готовим скилл, чтобы гашение было видно физически (перенос папки).
    mkdirSync(join(root, 'skills', 'мой-скилл'), { recursive: true });
    writeFileSync(join(root, 'skills', 'мой-скилл', 'SKILL.md'), '---\nname: мой-скилл\n---\nтело');

    const g = await createGroup({
      name: 'g',
      members: [{ kind: 'skill', id: 'мой-скилл' }],
    });

    // Выключаем группу — скилл уезжает в skills-disabled.
    await toggle(g, false);
    expect(existsSync(join(root, 'skills', 'мой-скилл'))).toBe(false);

    // Убираем скилл из состава выключенной группы.
    await putGroup(g, { name: 'g', members: [], isEnabled: false });

    // Ожидание: группа больше не содержит скилл → он должен вернуться в skills/.
    expect(existsSync(join(root, 'skills', 'мой-скилл'))).toBe(true);
    expect(store.disablingGroups('skill', 'мой-скилл')).toEqual([]);
  });
});
