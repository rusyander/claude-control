import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerGroupRoutes } from './group-routes.ts';

/**
 * Форма тела и границы маршрутов групп. Всё, что здесь отвергается, раньше
 * либо падало пятисоткой (`name` не строкой, `members` не списком), либо молча
 * уезжало в state.json (участник без id, `env` строкой, `projectPaths` строкой
 * — на нём падала страница), либо создавало сущность там, где её ждали найти
 * (PUT по неизвестному id) и отвечало «ok» на удаление несуществующего.
 *
 * Отдельно — то, что размывало состояние: PUT с флагом `isEnabled` переключал
 * одну группу без участников, удалённая вложенная группа оставалась призраком
 * в родителях, env новой группы не доезжал до settings.json.
 */
describe('маршруты групп: форма тела, 404/409 и согласованность', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  const settingsPath = (): string => join(root, 'settings.json');
  const readSettings = (): { env?: Record<string, string> } =>
    JSON.parse(readFileSync(settingsPath(), 'utf8'));

  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/groups', payload: payload as object });
  const put = (id: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: `/api/groups/${id}`, payload: payload as object });
  const create = async (payload: Record<string, unknown>): Promise<Group> => {
    const res = await post(payload);
    expect(res.statusCode).toBe(200);
    return res.json<Group>();
  };
  const groups = async (): Promise<Group[]> =>
    (await app.inject({ method: 'GET', url: '/api/groups' })).json<Group[]>();
  const errorCode = (res: { json: <T>() => T }): string => res.json<{ error: string }>().error;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-validation-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    mkdirSync(join(root, 'skills', 'audit-skill'), { recursive: true });
    writeFileSync(
      join(root, 'skills', 'audit-skill', 'SKILL.md'),
      '---\nname: audit-skill\n---\nтело',
    );
    writeFileSync(join(root, 'CLAUDE.md'), '# Правила\n', 'utf8');
    writeFileSync(settingsPath(), '{}');

    store = new AppStore(join(root, 'claude-control'));
    const ctx = {
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
    } as unknown as ServerContext;

    app = Fastify();
    registerGroupRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe('форма тела → 400 с причиной, ничего не записано', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['имя не строкой', { name: 123 }],
      ['участники не списком', { name: 'x', members: 'rule:a' }],
      ['участник неизвестного вида', { name: 'x', members: [{ kind: 'alien', id: 'a' }] }],
      ['участник без id', { name: 'x', members: [{ kind: 'rule' }] }],
      ['projectPaths строкой', { name: 'x', projectPaths: 'c:/work/x' }],
      ['env строкой', { name: 'x', env: 'A=1' }],
      ['значение env не строкой', { name: 'x', env: { A: 1 } }],
      ['имя переменной с цифры', { name: 'x', env: { '1BAD': 'x' } }],
      ['сценарий строкой', { name: 'x', scenario: 'делай так' }],
      ['isEnabled строкой', { name: 'x', isEnabled: 'yes' }],
    ];

    for (const [title, payload] of bad) {
      it(title, async () => {
        const res = await post(payload);

        expect(res.statusCode).toBe(400);
        expect(errorCode(res)).toBe('invalid_group_draft');
        expect(await groups()).toEqual([]);
      });
    }

    it('PUT проверяет тело так же, как POST', async () => {
      const group = await create({ name: 'ok' });
      const res = await put(group.id, { name: 'ok', members: 'oops' });

      expect(res.statusCode).toBe(400);
      expect((await groups())[0]?.members).toEqual([]);
    });
  });

  describe('неизвестный id → 404, а не создание или «ok»', () => {
    it('PUT по неизвестному id не заводит группу', async () => {
      const res = await put('нет-такой', { name: 'призрак' });

      expect(res.statusCode).toBe(404);
      expect(errorCode(res)).toBe('not_found');
      expect(await groups()).toEqual([]);
    });

    it('DELETE неизвестной группы', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/groups/нет-такой' });
      expect(res.statusCode).toBe(404);
    });

    it('PUT и DELETE неизвестного сценария-автоматизации', async () => {
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/automations/нет-такого',
        payload: { name: 'a', trigger: { event: 'Stop' }, action: { command: 'echo' } },
      });
      const delRes = await app.inject({ method: 'DELETE', url: '/api/automations/нет-такого' });

      expect(putRes.statusCode).toBe(404);
      expect(delRes.statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/automations' })).json()).toEqual([]);
    });
  });

  describe('имя уникально', () => {
    it('вторая группа с тем же именем (регистр и края не в счёт) → 409', async () => {
      await create({ name: 'Ревью' });
      const res = await post({ name: '  ревью ' });

      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('group_exists');
      expect(await groups()).toHaveLength(1);
    });

    it('переименование в занятое имя → 409, в своё же — 200', async () => {
      await create({ name: 'Первая' });
      const second = await create({ name: 'Вторая' });

      expect((await put(second.id, { name: 'первая' })).statusCode).toBe(409);
      expect((await put(second.id, { name: 'Вторая', description: 'та же' })).statusCode).toBe(200);
    });

    it('«Dev» и «dev» из старого state.json: правка каждой под своим именем — 200', async () => {
      const first = await create({ name: 'Dev' });
      // До проверки уникальности такое состояние записывалось свободно —
      // воспроизводим напрямую в хранилище, минуя POST.
      store.saveGroup({ ...first, id: 'legacy-dup', name: 'dev' });

      expect((await put(first.id, { name: 'Dev', description: 'обновлено' })).statusCode).toBe(200);
      expect((await put('legacy-dup', { name: 'dev', description: 'тоже' })).statusCode).toBe(200);

      // Занять имя соседа по-прежнему нельзя.
      const third = await create({ name: 'Third' });
      expect((await put(third.id, { name: 'dev' })).statusCode).toBe(409);
    });
  });

  describe('PUT не переключает группу', () => {
    const skillMember = { kind: 'skill', id: 'audit-skill' };

    it('isEnabled:false в теле игнорируется — группа и скилл остаются включёнными', async () => {
      const group = await create({ name: 'g', members: [skillMember] });
      const res = await put(group.id, { name: 'g', members: [skillMember], isEnabled: false });

      expect(res.statusCode).toBe(200);
      expect(res.json<Group>().isEnabled).toBe(true);
      expect(existsSync(join(root, 'skills', 'audit-skill'))).toBe(true);
    });

    it('isEnabled:true на выключенной группе игнорируется — скилл остаётся погашенным', async () => {
      const group = await create({ name: 'g', members: [skillMember] });
      await app.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/enabled`,
        payload: { isEnabled: false },
      });
      expect(existsSync(join(root, 'skills-disabled', 'audit-skill'))).toBe(true);

      const res = await put(group.id, { name: 'g', members: [skillMember], isEnabled: true });

      expect(res.json<Group>().isEnabled).toBe(false);
      expect(existsSync(join(root, 'skills-disabled', 'audit-skill'))).toBe(true);
      expect(existsSync(join(root, 'skills', 'audit-skill'))).toBe(false);
    });
  });

  it('удалённая вложенная группа уходит из состава родителей', async () => {
    const sub = await create({ name: 'sub' });
    const parent = await create({ name: 'parent', members: [{ kind: 'group', id: sub.id }] });

    await app.inject({ method: 'DELETE', url: `/api/groups/${sub.id}` });

    const after = (await groups()).find((item) => item.id === parent.id);
    expect(after?.members).toEqual([]);
  });

  it('order не повторяется после удалений', async () => {
    await create({ name: 'a' });
    const b = await create({ name: 'b' });
    await create({ name: 'c' });
    await app.inject({ method: 'DELETE', url: `/api/groups/${b.id}` });
    const d = await create({ name: 'd' });

    expect(d.order).toBe(3);
    const orders = (await groups()).map((item) => item.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  describe('env при создании', () => {
    it('переменные включённой группы доезжают до settings.json сразу', async () => {
      await create({ name: 'e', env: { AUDIT_FLAG: '1' } });

      expect(readSettings().env?.AUDIT_FLAG).toBe('1');
    });

    it('выключенная при создании группа ничего не пишет', async () => {
      await create({ name: 'e', env: { AUDIT_FLAG: '1' }, isEnabled: false });

      expect(readSettings().env?.AUDIT_FLAG).toBeUndefined();
    });
  });
});
