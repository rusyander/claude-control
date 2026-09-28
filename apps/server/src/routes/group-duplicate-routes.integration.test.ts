import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { groupCopyName } from '@agentdeck/contracts/groups';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerGroupRoutes } from './group-routes.ts';
import { registerGroupPathRoutes } from './group-path-routes.ts';
import { registerGroupDuplicateRoutes } from './group-duplicate-routes.ts';

/**
 * «Копировать группу» со стороны маршрутов: временный каталог конфигурации,
 * настоящие маршруты групп и «Пути». Независимость проверяется тем же путём,
 * что у панели: правка копии через PUT её пути и формы, удаление копии — и
 * после каждого шага оригинал читается заново с диска хранилища.
 */

const step = (id: string, patch: Partial<PathStep> = {}): PathStep => ({
  id,
  anchor: 'work',
  order: 0,
  kind: 'prompt',
  title: { ru: `шаг ${id}`, en: `step ${id}` },
  prompt: { ru: `сделать ${id}`, en: `do ${id}` },
  source: 'ru',
  createdAt: '2026-09-26T00:00:00.000Z',
  ...patch,
});

describe('маршрут копии группы', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  const skillsDir = (): string => join(root, 'skills');

  const original = (patch: Partial<Group> = {}): Group =>
    store.saveGroup({
      id: 'src',
      name: 'Доставка тикета',
      description: 'доводит тикет до MR',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'ladder' }],
      env: { TICKET_PREFIX: 'PROJ' },
      projectPaths: ['/work/app'],
      scope: { kind: 'project', path: '/work/app', provider: 'claude' },
      origin: {
        scope: { kind: 'global' },
        groupId: 'elsewhere',
        hash: 'h',
        copiedAt: '2026-09-01T00:00:00.000Z',
      },
      path: {
        steps: [
          step('s1'),
          step('s2', { order: 1, within: { skillId: 'ladder', index: 0, after: 'Read' } }),
        ],
      },
      knobs: { 'ladder:reviewers': 3 },
      flow: 'conveyor',
      when: 'тикет трекера надо довести до MR',
      isEnabled: true,
      order: 4,
      ...patch,
    });

  const reread = (id: string): Group | undefined =>
    new AppStore(join(root, 'agentdeck')).getGroups().find((group) => group.id === id);

  const duplicate = (id: string, payload: unknown = {}) =>
    app.inject({ method: 'POST', url: `/api/groups/${id}/duplicate`, payload: payload as object });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-duplicate-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(skillsDir(), 'ladder'), { recursive: true });
    writeFileSync(
      join(skillsDir(), 'ladder', 'SKILL.md'),
      '---\nname: ladder\ndescription: ladder\n---\n\n## 1. Read\n\n## 2. Ship\n',
      'utf8',
    );
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    writeFileSync(join(root, 'CLAUDE.md'), '# Правила\n', 'utf8');
    store = new AppStore(join(root, 'agentdeck'));
    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: skillsDir(),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          appData: join(root, 'agentdeck'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
    } as unknown as ServerContext;
    app = Fastify();
    registerGroupRoutes(app, ctx);
    registerGroupPathRoutes(app, ctx, () => async () => 'no block');
    registerGroupDuplicateRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('копия несёт шаги, числа, «Когда», ход и область; id шагов новые; выключена; без привязки и origin', async () => {
    original();
    const res = await duplicate('src', { lang: 'ru' });
    expect(res.statusCode).toBe(200);
    const { group, sourceId } = res.json() as { group: Group; sourceId: string };
    expect(sourceId).toBe('src');
    expect(group.id).not.toBe('src');
    expect(group.name).toBe('Доставка тикета (копия)');
    expect(group.isEnabled).toBe(false);
    expect(group.when).toBe('тикет трекера надо довести до MR');
    expect(group.flow).toBe('conveyor');
    expect(group.knobs).toEqual({ 'ladder:reviewers': 3 });
    expect(group.scope).toEqual({ kind: 'project', path: '/work/app', provider: 'claude' });
    expect(group.env).toEqual({ TICKET_PREFIX: 'PROJ' });
    expect(group.members).toEqual([{ kind: 'skill', id: 'ladder' }]);
    expect(group.projectPaths).toEqual([]);
    expect(group.origin).toBeUndefined();
    expect(group.order).toBe(5);
    const steps = group.path?.steps ?? [];
    expect(steps.map((item) => item.title.ru)).toEqual(['шаг s1', 'шаг s2']);
    expect(steps[1]!.within).toEqual({ skillId: 'ladder', index: 0, after: 'Read' });
    expect(steps.map((item) => item.id)).not.toContain('s1');
    expect(steps.map((item) => item.id)).not.toContain('s2');
    expect(new Set(steps.map((item) => item.id)).size).toBe(2);
  });

  it('выключенная копия ничего не гасит: общий скилл оригинала остаётся включённым на диске', async () => {
    original();
    const { group } = (await duplicate('src')).json() as { group: Group };
    expect(store.disablingGroups('skill', 'ladder')).toEqual([]);
    expect(existsSync(join(skillsDir(), 'ladder', 'SKILL.md'))).toBe(true);
    // Сама копия при этом честно выключаемая: включить-выключить — и она гасит как все.
    await app.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/enabled`,
      payload: { isEnabled: true },
    });
    expect(store.disablingGroups('skill', 'ladder')).toEqual([]);
  });

  it('копия независима: правка её пути и формы, затем удаление — оригинал не меняется', async () => {
    original();
    const before = reread('src');
    const { group } = (await duplicate('src')).json() as { group: Group };
    const steps = group.path!.steps;

    const put = await app.inject({
      method: 'PUT',
      url: `/api/groups/${group.id}/path/steps`,
      payload: {
        steps: [{ ...steps[0]!, title: { ru: 'другой', en: 'other' } }, step('s3', { order: 1 })],
      },
    });
    expect(put.statusCode).toBe(200);
    const form = await app.inject({
      method: 'PUT',
      url: `/api/groups/${group.id}`,
      payload: {
        name: 'Своя доставка',
        description: 'другое',
        members: [],
        env: {},
        when: 'совсем другое',
      },
    });
    expect(form.statusCode).toBe(200);
    expect(reread(group.id)?.path?.steps.map((item) => item.title.ru)).toEqual([
      'другой',
      'шаг s3',
    ]);
    expect(reread('src')).toEqual(before);

    const removed = await app.inject({ method: 'DELETE', url: `/api/groups/${group.id}` });
    expect(removed.statusCode).toBe(200);
    expect(reread('src')).toEqual(before);
    expect(reread(group.id)).toBeUndefined();
  });

  it('имя: «(копия)», затем «(копия 2)»; копия копии не наращивает скобки; en — «(copy)»', async () => {
    original();
    const first = (await duplicate('src', { lang: 'ru' })).json() as { group: Group };
    const second = (await duplicate('src', { lang: 'ru' })).json() as { group: Group };
    const ofCopy = (await duplicate(first.group.id, { lang: 'ru' })).json() as { group: Group };
    const english = (await duplicate('src', { lang: 'en' })).json() as { group: Group };
    expect(first.group.name).toBe('Доставка тикета (копия)');
    expect(second.group.name).toBe('Доставка тикета (копия 2)');
    expect(ofCopy.group.name).toBe('Доставка тикета (копия 3)');
    expect(english.group.name).toBe('Доставка тикета (copy)');
    expect(groupCopyName('A (копия 2)', ['a (КОПИЯ)'], 'ru')).toBe('A (копия 2)');
  });

  it('своё имя занято — 409 group_exists; группы нет — 404; кривое тело — 400', async () => {
    original();
    const taken = await duplicate('src', { name: ' доставка ТИКЕТА ' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: 'group_exists', messageCode: 'group-name-taken' });
    expect((await duplicate('nope')).statusCode).toBe(404);
    const bad = await duplicate('src', { lang: 'de' });
    expect(bad.statusCode).toBe(400);
    expect(store.getGroups()).toHaveLength(1);
  });
});
