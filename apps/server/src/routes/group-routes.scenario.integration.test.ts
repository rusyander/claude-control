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
 * Порядок работы и привязка к проекту — со стороны маршрутов, на временном
 * каталоге.
 *
 * Проверяется то, ради чего всё и делалось: шаги, описанные в панели, доезжают
 * до диска в виде скилла и хука (иначе Claude о них никогда не узнает), а
 * привязанная группа включается сама от прогона в её каталоге.
 */
describe('маршруты групп: сценарий и привязка к проекту', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  const settingsPath = (): string => join(root, 'settings.json');
  const skillDir = (id: string): string => join(root, 'skills', id);
  const readSettings = (): { hooks?: Record<string, unknown> } =>
    JSON.parse(readFileSync(settingsPath(), 'utf8'));

  const createGroup = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/groups', payload });

  const scenarioPayload = {
    name: 'Задача из Jira',
    projectPaths: ['c:/work/gorgona'],
    scenario: {
      when: 'прилетел тикет',
      trigger: 'GOR-\\d+',
      steps: [
        { title: 'Забрать тикет', body: 'assign + В работе', gate: 'статус «В работе»' },
        { title: 'Ветка от main', body: '', gate: 'git branch показывает новую' },
      ],
    },
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-scenario-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(settingsPath(), '{}', 'utf8');

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

  it('шаги доезжают до диска: скилл, участие в группе, хук-триггер', async () => {
    const res = await createGroup(scenarioPayload);
    const group = res.json<Group>();

    expect(res.statusCode).toBe(200);

    // Скилл — единственная форма, в которой Claude вообще увидит эти шаги.
    const text = readFileSync(join(skillDir('scenario-zadacha-iz-jira'), 'SKILL.md'), 'utf8');
    expect(text).toContain('### 1. Забрать тикет');
    expect(text).toContain('**Готово, когда:** статус «В работе»');

    // Участие обязательно: иначе скилл не погаснет вместе с группой.
    expect(group.members).toContainEqual({ kind: 'skill', id: 'scenario-zadacha-iz-jira' });
    expect(group.scenario?.compiledSkillId).toBe('scenario-zadacha-iz-jira');

    // Триггер — хук на запрос пользователя, со скриптом рядом со скиллом.
    expect(existsSync(join(skillDir('scenario-zadacha-iz-jira'), 'trigger.mjs'))).toBe(true);
    expect(JSON.stringify(readSettings().hooks)).toContain('claude-control:scenario');
  });

  it('негодное выражение триггера отвергается до записи', async () => {
    const res = await createGroup({
      name: 'Сломанный',
      scenario: { when: '', trigger: 'GOR-(\\d+', steps: [{ title: 'шаг', body: '', gate: '' }] },
    });

    expect(res.statusCode).toBe(400);
    expect(existsSync(skillDir('scenario-slomannyy'))).toBe(false);
  });

  it('выключение группы уносит триггер, скилл уезжает в skills-disabled', async () => {
    const group = (await createGroup(scenarioPayload)).json<Group>();

    await app.inject({
      method: 'POST',
      url: `/api/groups/${group.id}/enabled`,
      payload: { isEnabled: false },
    });

    expect(JSON.stringify(readSettings().hooks ?? {})).not.toContain('claude-control:scenario');
    expect(existsSync(skillDir('scenario-zadacha-iz-jira'))).toBe(false);
    expect(existsSync(join(root, 'skills-disabled', 'scenario-zadacha-iz-jira', 'SKILL.md'))).toBe(
      true,
    );
  });

  it('привязанная группа включается от прогона в её каталоге', async () => {
    const group = (await createGroup({ ...scenarioPayload, isEnabled: false })).json<Group>();

    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/activate',
      payload: { path: 'c:/work/gorgona/apps/web' },
    });

    expect(res.json<{ activated: string[] }>().activated).toEqual(['Задача из Jira']);
    expect(store.getGroups().find((item) => item.id === group.id)?.isEnabled).toBe(true);
    // Включилась группа — вернулся и её сценарий.
    expect(JSON.stringify(readSettings().hooks)).toContain('claude-control:scenario');
  });

  it('прогон в чужом каталоге ничего не включает', async () => {
    await createGroup({ ...scenarioPayload, isEnabled: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/activate',
      payload: { path: 'c:/work/other' },
    });

    expect(res.json<{ activated: string[] }>().activated).toEqual([]);
  });
});
