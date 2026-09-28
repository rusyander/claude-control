import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { readHooks } from '../domains/hooks.ts';
import { buildScenarioBody } from '../domains/group-scenario.ts';
import { registerGroupRoutes } from './group-routes.ts';

/**
 * Порядок работы и привязка к проекту — со стороны маршрутов, на временном
 * каталоге.
 *
 * Шаги старой формы доезжают до «Пути» группы (скилла и хука-триггера больше
 * нет), правка формы не стирает поля, которые правят другие маршруты, а
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
    projectPaths: ['c:/work/company'],
    scenario: {
      when: 'прилетел тикет',
      trigger: 'PRJ-\\d+',
      steps: [
        { title: 'Забрать тикет', body: 'assign + В работе', gate: 'статус «В работе»' },
        { title: 'Ветка от main', body: '', gate: 'git branch показывает новую' },
      ],
    },
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-scenario-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(settingsPath(), '{}', 'utf8');

    store = new AppStore(join(root, 'agentdeck'));

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
          appData: join(root, 'agentdeck'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
    } as unknown as ServerContext;

    app = Fastify();
    registerGroupRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('шаги старой формы уходят в путь: ни скилла, ни хука-триггера', async () => {
    const res = await createGroup(scenarioPayload);
    const group = res.json<Group>();

    expect(res.statusCode).toBe(200);
    expect(group.path?.steps.map((step) => step.title.ru)).toEqual([
      'Забрать тикет',
      'Ветка от main',
    ]);
    expect(group.path?.steps.every((step) => step.anchor === 'work')).toBe(true);
    expect(existsSync(skillDir('scenario-zadacha-iz-jira'))).toBe(false);
    expect(group.members).toEqual([]);
    expect(JSON.stringify(readSettings().hooks ?? {})).not.toContain('agentdeck:scenario');
  });

  it('уцелевший триггер снимается сохранением, ручной хук остаётся', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: 'command', command: 'node t.mjs # agentdeck:scenario g0' },
                { type: 'command', command: 'echo manual' },
              ],
            },
          ],
        },
      }),
      'utf8',
    );

    await createGroup({ name: 'Любая' });

    expect(readHooks(settingsPath(), store).map((hook) => hook.command)).toEqual(['echo manual']);
  });

  it('правка формы не стирает путь, происхождение, область и when', async () => {
    const group = (await createGroup({ name: 'Копия', when: 'релиз' })).json<Group>();
    const origin = {
      scope: { kind: 'project' as const, path: 'c:/work/demo', provider: 'claude' },
      groupId: 'p1',
      hash: 'h',
      copiedAt: '2026-09-26T00:00:00.000Z',
    };
    const path = { steps: (await createGroup(scenarioPayload)).json<Group>().path!.steps };
    store.saveGroup({ ...store.getGroups().find((g) => g.id === group.id)!, origin, path });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/groups/${group.id}`,
      payload: { name: 'Копия 2' },
    });
    const saved = res.json<Group>();

    expect(res.statusCode).toBe(200);
    expect(saved.name).toBe('Копия 2');
    expect(saved.origin).toEqual(origin);
    expect(saved.path?.steps).toHaveLength(2);
    expect(saved.when).toBe('релиз');
  });

  it('«Когда», присланное пустым, стирается; пробелы — тоже пусто (F-71)', async () => {
    const group = (await createGroup({ name: 'Когда-группа', when: 'релиз' })).json<Group>();
    const put = (when: string) =>
      app.inject({ method: 'PUT', url: `/api/groups/${group.id}`, payload: { name: 'К', when } });
    const cleared = await put('');
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<Group>()).not.toHaveProperty('when');
    expect(store.getGroups().find((g) => g.id === group.id)).not.toHaveProperty('when');
    expect((await put('  ')).json<Group>()).not.toHaveProperty('when');
  });

  it('сценарий: POST с flow и пустым путём, правка формы без flow его не теряет, с flow — меняет', async () => {
    const created = await createGroup({ name: 'Сдача задачи', flow: 'scenario' });
    expect(created.statusCode).toBe(200);
    const group = created.json<Group>();
    expect(group.flow).toBe('scenario');
    expect(group.path?.steps ?? []).toEqual([]);
    const onDisk = () =>
      new AppStore(join(root, 'agentdeck')).getGroups().find((g) => g.id === group.id);
    expect(onDisk()?.flow).toBe('scenario');

    const put = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PUT', url: `/api/groups/${group.id}`, payload });
    expect((await put({ name: 'Сдача задачи 2' })).json<Group>().flow).toBe('scenario');
    expect(onDisk()?.flow).toBe('scenario');
    expect((await put({ name: 'Сдача задачи 2', flow: 'conveyor' })).json<Group>().flow).toBe(
      'conveyor',
    );
    expect(onDisk()?.flow).toBe('conveyor');
  });

  // Ревью 28.09 (F-259): перенос при сохранении переносил шаги, но оставлял
  // скомпилированный `scenario-<slug>` участником — дубль подсказки жил, а
  // перенос при запуске эту группу (путь уже есть) больше не трогал.
  it('сохранение старой группы снимает нетронутый скомпилированный скилл, как перенос при запуске', async () => {
    const legacy: Group = {
      id: 'legacy-1',
      name: 'Старая',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'scenario-staraya' }],
      env: {},
      projectPaths: [],
      isEnabled: true,
      order: 0,
      scenario: { ...scenarioPayload.scenario, compiledSkillId: 'scenario-staraya' },
    };
    store.saveGroup(legacy);
    mkdirSync(skillDir('scenario-staraya'), { recursive: true });
    const body = buildScenarioBody(legacy, legacy.scenario!);
    writeFileSync(
      join(skillDir('scenario-staraya'), 'SKILL.md'),
      `---\nname: scenario-staraya\ndescription: d\n---\n\n${body}\n`,
    );

    const res = await app.inject({
      method: 'PUT',
      url: `/api/groups/${legacy.id}`,
      payload: { name: 'Старая', scenario: scenarioPayload.scenario },
    });

    expect(res.statusCode).toBe(200);
    const saved = res.json<Group>();
    expect(saved.path?.steps).toHaveLength(2);
    expect(saved.members).toEqual([]);
    expect(saved.scenario?.compiledSkillId).toBeUndefined();
    expect(existsSync(skillDir('scenario-staraya'))).toBe(false);
    expect(existsSync(join(root, 'agentdeck', 'backups'))).toBe(true);
  });

  it('GET отдаёт группу с usedIn по привязке', async () => {
    await createGroup(scenarioPayload);
    const [view] = (await app.inject({ method: 'GET', url: '/api/groups' })).json<
      (Group & { usedIn: string[] })[]
    >();
    expect(view?.usedIn).toEqual(['c:/work/company']);
  });

  it('негодное выражение триггера отвергается до записи', async () => {
    const res = await createGroup({
      name: 'Сломанный',
      scenario: { when: '', trigger: 'PRJ-(\\d+', steps: [{ title: 'шаг', body: '', gate: '' }] },
    });

    expect(res.statusCode).toBe(400);
    expect(existsSync(skillDir('scenario-slomannyy'))).toBe(false);
  });

  it('привязанная группа включается от прогона в её каталоге', async () => {
    const group = (await createGroup({ ...scenarioPayload, isEnabled: false })).json<Group>();

    const res = await app.inject({
      method: 'POST',
      url: '/api/groups/activate',
      payload: { path: 'c:/work/company/apps/web' },
    });

    expect(res.json<{ activated: string[] }>().activated).toEqual(['Задача из Jira']);
    expect(store.getGroups().find((item) => item.id === group.id)?.isEnabled).toBe(true);
    // Включение триггера сценария больше не возвращает.
    expect(JSON.stringify(readSettings().hooks ?? {})).not.toContain('agentdeck:scenario');
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
