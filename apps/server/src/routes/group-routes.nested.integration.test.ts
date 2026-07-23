import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group, GroupMember } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerGroupRoutes } from './group-routes.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * Вложенные группы: группа может входить участником в другую, и переключатель
 * родителя обязан гасить/зажигать потомков по всей ветке. Плюс защита от циклов
 * и сохранение заданного порядка участников — всё на живом Fastify и временном
 * каталоге, как это работает из панели.
 */
describe('маршруты групп: вложенность, циклы и порядок', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  const skillPath = (name: string): string => join(root, 'skills', name);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-nested-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });

    for (const name of ['skill-a', 'skill-b']) {
      mkdirSync(skillPath(name), { recursive: true });
      writeFileSync(join(skillPath(name), 'SKILL.md'), `---\nname: ${name}\n---\nтело`);
    }
    writeFileSync(join(root, 'settings.json'), JSON.stringify({}, null, 2));

    store = new AppStore(join(root, 'claude-control'));

    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
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
    registerEntityRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const createGroup = async (name: string, members: GroupMember[]): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { name, members },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ id: string }>().id;
  };

  const toggle = (id: string, isEnabled: boolean) =>
    app.inject({ method: 'POST', url: `/api/groups/${id}/enabled`, payload: { isEnabled } });

  it('выключение родителя гасит участников вложенной группы', async () => {
    const inner = await createGroup('Вложенная', [{ kind: 'skill', id: 'skill-b' }]);
    const outer = await createGroup('Родитель', [
      { kind: 'skill', id: 'skill-a' },
      { kind: 'group', id: inner },
    ]);

    const res = await toggle(outer, false);
    expect(res.statusCode).toBe(200);
    // Задеты оба листа: прямой skill-a и потомок skill-b из вложенной группы.
    expect(res.json<{ affected: number }>().affected).toBe(2);

    expect(existsSync(skillPath('skill-a'))).toBe(false);
    expect(existsSync(skillPath('skill-b'))).toBe(false);
    // Отметка удержания стоит от id родителя — по всей ветке.
    expect(store.disablingGroups('skill', 'skill-b')).toEqual([outer]);
  });

  it('включение родителя возвращает потомков вложенной группы', async () => {
    const inner = await createGroup('Вложенная', [{ kind: 'skill', id: 'skill-b' }]);
    const outer = await createGroup('Родитель', [{ kind: 'group', id: inner }]);

    await toggle(outer, false);
    expect(existsSync(skillPath('skill-b'))).toBe(false);

    await toggle(outer, true);
    expect(existsSync(skillPath('skill-b'))).toBe(true);
    expect(store.disablingGroups('skill', 'skill-b')).toEqual([]);
  });

  it('потомок оживает, только когда его отпустили обе гасящие ветки', async () => {
    // skill-b держат обе группы напрямую; отпускание одной его не воскрешает.
    const g1 = await createGroup('Г1', [{ kind: 'skill', id: 'skill-b' }]);
    const g2 = await createGroup('Г2', [{ kind: 'skill', id: 'skill-b' }]);

    await toggle(g1, false);
    await toggle(g2, false);
    expect(existsSync(skillPath('skill-b'))).toBe(false);

    await toggle(g1, true);
    expect(existsSync(skillPath('skill-b'))).toBe(false);

    await toggle(g2, true);
    expect(existsSync(skillPath('skill-b'))).toBe(true);
  });

  it('цикл A→B→A отвергается при сохранении', async () => {
    const a = await createGroup('A', [{ kind: 'skill', id: 'skill-a' }]);
    const b = await createGroup('B', [{ kind: 'group', id: a }]);

    // Теперь пытаемся вложить B в A — получится петля A→B→A.
    const res = await app.inject({
      method: 'PUT',
      url: `/api/groups/${a}`,
      payload: { name: 'A', members: [{ kind: 'group', id: b }], env: {}, isEnabled: true },
    });

    expect(res.statusCode).toBe(400);
    // Состав A не изменился — петлю не записали.
    const groups = (await app.inject({ method: 'GET', url: '/api/groups' })).json<Group[]>();
    const savedA = groups.find((group) => group.id === a);
    expect(savedA?.members).toEqual([{ kind: 'skill', id: 'skill-a' }]);
  });

  it('прямая ссылка группы на себя отвергается', async () => {
    const a = await createGroup('A', [{ kind: 'skill', id: 'skill-a' }]);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/groups/${a}`,
      payload: { name: 'A', members: [{ kind: 'group', id: a }], env: {}, isEnabled: true },
    });

    expect(res.statusCode).toBe(400);
  });

  it('заданный порядок участников сохраняется и переживает перестановку', async () => {
    const id = await createGroup('Порядок', [
      { kind: 'skill', id: 'skill-a' },
      { kind: 'skill', id: 'skill-b' },
    ]);

    const readMembers = async (): Promise<GroupMember[]> => {
      const groups = (await app.inject({ method: 'GET', url: '/api/groups' })).json<Group[]>();
      return groups.find((group) => group.id === id)!.members;
    };

    expect(await readMembers()).toEqual([
      { kind: 'skill', id: 'skill-a' },
      { kind: 'skill', id: 'skill-b' },
    ]);

    // Меняем порядок местами — панель шлёт члены в новом порядке.
    await app.inject({
      method: 'PUT',
      url: `/api/groups/${id}`,
      payload: {
        name: 'Порядок',
        members: [
          { kind: 'skill', id: 'skill-b' },
          { kind: 'skill', id: 'skill-a' },
        ],
        env: {},
        isEnabled: true,
      },
    });

    expect(await readMembers()).toEqual([
      { kind: 'skill', id: 'skill-b' },
      { kind: 'skill', id: 'skill-a' },
    ]);
  });
});
