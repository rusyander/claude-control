import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerEntityRoutes } from './entity-routes.ts';

/**
 * Идентификатор права — это решение и шаблон, поэтому правка и перенос между
 * файлами меняют его. Отметки и состав групп ключуются этим id: раньше после
 * правки группа теряла участника, а в state.json оставался призрак. Заодно
 * закрыт вход без проверки: `decision: "zzz"` заводил в settings.json список,
 * которого Claude Code не знает, а дубль и удаление несуществующего отвечали
 * 200 и переписывали файл с резервной копией.
 */
describe('/api/permissions — id переезжает вместе с правкой', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  const GS = 'Bash(git status:*)';
  const settingsPath = (): string => join(root, 'settings.json');
  const localPath = (): string => join(root, 'settings.local.json');
  const perms = (path: string): Record<string, string[]> =>
    JSON.parse(readFileSync(path, 'utf8')).permissions ?? {};
  const members = (): string[] =>
    store
      .getGroups()
      .find((group) => group.id === 'g1')!
      .members.map((member) => member.id);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-perm-routes-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    writeFileSync(
      join(root, 'claude-control', 'state.json'),
      JSON.stringify({
        groups: [
          {
            id: 'g1',
            name: 'Проба',
            description: '',
            color: 'accent',
            icon: 'folder',
            members: [
              { kind: 'permission', id: `allow:${GS}` },
              { kind: 'permission', id: 'local:allow:WebFetch' },
            ],
            env: {},
            isEnabled: true,
            order: 0,
          },
        ],
        automations: [],
        disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
        disabledHooks: {},
      }),
    );
    writeFileSync(
      settingsPath(),
      JSON.stringify({ permissions: { allow: [GS, 'Read', 'mcp__srv'], deny: [] } }),
    );
    writeFileSync(localPath(), JSON.stringify({ permissions: { allow: ['WebFetch'] } }));
    store = new AppStore(join(root, 'claude-control'));

    const ctx = {
      location: {
        paths: {
          root,
          settings: settingsPath(),
          settingsLocal: localPath(),
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
    registerEntityRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET: правило на сервер целиком несёт mcpServer без mcpTool', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/permissions' });
    const whole = res.json().find((r: { pattern: string }) => r.pattern === 'mcp__srv');
    expect(whole).toMatchObject({ mcpServer: 'srv' });
    expect(whole.mcpTool).toBeUndefined();
  });

  it('POST: неизвестное решение и пустой шаблон → 400, файл не тронут', async () => {
    const before = readFileSync(settingsPath(), 'utf8');
    const junk = await app.inject({
      method: 'POST',
      url: '/api/permissions',
      payload: { pattern: 'Probe', decision: 'zzprobe', groupIds: [] },
    });
    const blank = await app.inject({
      method: 'POST',
      url: '/api/permissions',
      payload: { pattern: '   ', decision: 'allow', groupIds: [] },
    });
    expect(junk.statusCode).toBe(400);
    expect(blank.statusCode).toBe(400);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(before);
  });

  it('POST: дубль в том же файле → 409; шаблон обрезается по краям', async () => {
    const dup = await app.inject({
      method: 'POST',
      url: '/api/permissions',
      payload: { pattern: ' Read ', decision: 'allow', groupIds: [] },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'permission_exists' });

    const ok = await app.inject({
      method: 'POST',
      url: '/api/permissions',
      payload: { pattern: '  Edit ', decision: 'ask', groupIds: [] },
    });
    expect(ok.statusCode).toBe(200);
    expect(perms(settingsPath()).ask).toEqual(['Edit']);
  });

  it('PUT: смена решения переносит участие в группе на новый id', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/permissions/${encodeURIComponent(`allow:${GS}`)}`,
      payload: { pattern: GS, decision: 'ask', groupIds: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(perms(settingsPath()).allow).not.toContain(GS);
    expect(perms(settingsPath()).ask).toEqual([GS]);
    expect(members()).toContain(`ask:${GS}`);
    expect(members()).not.toContain(`allow:${GS}`);
  });

  it('PUT: отсутствующее правило → 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/permissions/${encodeURIComponent('deny:Nope')}`,
      payload: { pattern: 'Nope', decision: 'deny', groupIds: [] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('move: локальное право уходит в общий файл, участие в группе следует за ним', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/permissions/${encodeURIComponent('local:allow:WebFetch')}/move`,
    });
    expect(res.statusCode).toBe(200);
    expect(perms(localPath()).allow).toEqual([]);
    expect(perms(settingsPath()).allow).toContain('WebFetch');
    expect(members()).toContain('allow:WebFetch');
    expect(members()).not.toContain('local:allow:WebFetch');

    const back = await app.inject({
      method: 'POST',
      url: `/api/permissions/${encodeURIComponent('allow:WebFetch')}/move`,
    });
    expect(back.statusCode).toBe(200);
    expect(members()).toContain('local:allow:WebFetch');
  });

  it('DELETE: отсутствующее правило → 404 без записи; существующее уходит вместе с отметками', async () => {
    const before = readFileSync(settingsPath(), 'utf8');
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/permissions/${encodeURIComponent('deny:Nope')}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(before);

    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/permissions/${encodeURIComponent(`allow:${GS}`)}`,
    });
    expect(gone.statusCode).toBe(200);
    expect(perms(settingsPath()).allow).not.toContain(GS);
    expect(members()).not.toContain(`allow:${GS}`);
  });

  /**
   * Право, выключенное тумблером, в файле отсутствует — его помнит только
   * отметка панели, а список показывает его как «выключено» с теми же кнопками
   * правки, удаления и переноса. Раньше все три отвечали 404 (`hasPermission`
   * смотрит в файл), отметка оставалась — строка становилась неубиваемой.
   */
  describe('право, выключенное тумблером: в файле нет, есть отметка', () => {
    const OFF = 'ask:WebSearch';

    const listed = async (): Promise<Array<{ id: string; isEnabled: boolean; source: string }>> =>
      (await app.inject({ method: 'GET', url: '/api/permissions' })).json();

    beforeEach(() => {
      store.setEnabled('permission', OFF, false);
    });

    it('GET показывает его выключенным', async () => {
      expect(await listed()).toContainEqual(expect.objectContaining({ id: OFF, isEnabled: false }));
    });

    it('DELETE снимает отметку: строка исчезает, файл не тронут', async () => {
      const before = readFileSync(settingsPath(), 'utf8');
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/permissions/${encodeURIComponent(OFF)}`,
      });
      expect(res.statusCode).toBe(200);
      expect((await listed()).some((rule) => rule.id === OFF)).toBe(false);
      expect(store.getDisabledIds('permission')).not.toContain(OFF);
      expect(readFileSync(settingsPath(), 'utf8')).toBe(before);
    });

    it('PUT переносит отметку на новый id, в файл ничего не пишет', async () => {
      const before = readFileSync(settingsPath(), 'utf8');
      const res = await app.inject({
        method: 'PUT',
        url: `/api/permissions/${encodeURIComponent(OFF)}`,
        payload: { pattern: 'WebSearch', decision: 'allow', groupIds: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(store.getDisabledIds('permission')).toContain('allow:WebSearch');
      expect(store.getDisabledIds('permission')).not.toContain(OFF);
      expect(await listed()).toContainEqual(
        expect.objectContaining({ id: 'allow:WebSearch', isEnabled: false }),
      );
      expect(readFileSync(settingsPath(), 'utf8')).toBe(before);
    });

    it('PUT под id живого правила → 409: отметка не гасит чужую запись', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/permissions/${encodeURIComponent(OFF)}`,
        payload: { pattern: 'Read', decision: 'allow', groupIds: [] },
      });
      expect(res.statusCode).toBe(409);
      expect(store.getDisabledIds('permission')).toContain(OFF);
      expect(store.getDisabledIds('permission')).not.toContain('allow:Read');
    });

    it('move переводит отметку в локальный файл, записи не создаёт', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/permissions/${encodeURIComponent(OFF)}/move`,
      });
      expect(res.statusCode).toBe(200);
      expect(store.getDisabledIds('permission')).toContain(`local:${OFF}`);
      expect(perms(localPath()).ask ?? []).not.toContain('WebSearch');
      expect(await listed()).toContainEqual(
        expect.objectContaining({ id: `local:${OFF}`, source: 'settings-local', isEnabled: false }),
      );
    });
  });
});
