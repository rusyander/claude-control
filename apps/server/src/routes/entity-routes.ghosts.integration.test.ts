import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * Удаление сущности любого вида не оставляет следа в state.json.
 *
 * Отметки («выключено вручную», «погашено группой») и состав групп ключуются
 * идентификатором, а идентификатор — это имя (папка скилла, паттерн права,
 * заголовок правила). Раньше удалялась только запись в конфиге: группа
 * показывала участника-призрака, а сущность, заведённая потом под тем же
 * именем, наследовала чужие группы и могла оказаться погашенной группой, в
 * которую никогда не входила. Призрак есть призрак — проверяем все виды.
 */
describe('маршруты сущностей: удаление не оставляет призраков в state.json', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  const group = (members: Group['members']): Group => ({
    id: 'g1',
    name: 'Работа',
    description: '',
    color: 'accent',
    icon: 'folder',
    members,
    env: {},
    isEnabled: true,
    order: 0,
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-ghosts-'));
    const appData = join(root, 'claude-control');
    mkdirSync(appData, { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}\n');
    store = new AppStore(appData);

    const ctx = {
      location: {
        paths: {
          root,
          appData,
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
      backupDir: join(appData, 'backups'),
    } as unknown as ServerContext;

    app = Fastify();
    registerEntityRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('скилл: удаление снимает участие в группе и обе отметки', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: { name: 'a11y-audit', description: 'Проверка доступности', body: 'текст' },
    });
    expect(created.statusCode).toBe(200);

    store.saveGroup(group([{ kind: 'skill', id: 'a11y-audit' }]));
    store.setEnabled('skill', 'a11y-audit', false);
    store.setGroupDisabled('skill', 'a11y-audit', 'g1', true);

    const deleted = await app.inject({ method: 'DELETE', url: '/api/skills/a11y-audit' });
    expect(deleted.statusCode).toBe(200);

    expect(store.getGroups()[0]?.members).toEqual([]);
    expect(store.isDisabled('skill', 'a11y-audit')).toBe(false);
  });

  it('право: удаление снимает участие в группе и обе отметки', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/permissions',
      payload: { pattern: 'Bash(git push:*)', decision: 'deny', groupIds: [] },
    });
    expect(created.statusCode).toBe(200);

    // Идентификатор права — решение и шаблон; несуществующий id теперь 404.
    const id = 'deny:Bash(git push:*)';
    store.saveGroup(group([{ kind: 'permission', id }]));
    store.setEnabled('permission', id, false);
    store.setGroupDisabled('permission', id, 'g1', true);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/permissions/${encodeURIComponent(id)}`,
    });
    expect(deleted.statusCode).toBe(200);

    expect(store.getGroups()[0]?.members).toEqual([]);
    expect(store.isDisabled('permission', id)).toBe(false);
  });

  it('хук: удаление снимает след — новый хук с тем же содержимым групп не наследует', async () => {
    // У хука id контентный: тот же текст команды даёт тот же id. Без очистки
    // заново заведённый хук приходил бы уже состоящим в чужой группе.
    const created = await app.inject({
      method: 'POST',
      url: '/api/hooks',
      payload: {
        event: 'Stop',
        matchers: [],
        command: 'echo привет',
        isEnabled: true,
        groupIds: [],
      },
    });
    expect(created.statusCode).toBe(200);

    const listed = await app.inject({ method: 'GET', url: '/api/hooks' });
    const id = listed.json<Array<{ id: string }>>()[0]?.id;
    expect(id).toBeDefined();

    store.saveGroup(group([{ kind: 'hook', id: id! }]));
    store.setGroupDisabled('hook', id!, 'g1', true);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/hooks/${encodeURIComponent(id!)}`,
    });
    expect(deleted.statusCode).toBe(200);

    expect(store.getGroups()[0]?.members).toEqual([]);
    expect(store.isDisabled('hook', id!)).toBe(false);
  });

  it('правило: удаление снимает след, а отметки уцелевшего тёзки переезжают верно', async () => {
    // Удаление правила сдвигает идентификаторы: из «Стиль» и «Стиль-2»
    // уцелевший становится «Стиль». Снимать след надо ДО этого сдвига, иначе
    // стёрлись бы отметки выжившего.
    for (let n = 0; n < 2; n += 1) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/rules',
        payload: { title: 'Стиль', body: 'текст', groupIds: [] },
      });
      expect(created.statusCode).toBe(200);
    }

    // Идентификатор правила — slug заголовка, спрашиваем его у самого раздела.
    const listed = await app.inject({ method: 'GET', url: '/api/rules' });
    const [first, second] = listed.json<Array<{ id: string }>>().map((rule) => rule.id);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    store.saveGroup(
      group([
        { kind: 'rule', id: first! },
        { kind: 'rule', id: second! },
      ]),
    );
    store.setEnabled('rule', second!, false);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/rules/${encodeURIComponent(first!)}`,
    });
    expect(deleted.statusCode).toBe(200);

    // Выживший переехал на освободившийся id и остался в группе ровно одним
    // участником — вместе со своей отметкой выключения.
    expect(store.getGroups()[0]?.members).toEqual([{ kind: 'rule', id: first }]);
    expect(store.isDisabledManually('rule', first!)).toBe(true);
    expect(store.isDisabledManually('rule', second!)).toBe(false);
  });
});
