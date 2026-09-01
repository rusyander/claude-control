import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudePaths, Group } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { readHooks } from './hooks.ts';
import {
  buildScenarioBody,
  compileScenarioHooks,
  compileScenarioSkill,
  isValidTrigger,
  scenarioSkillId,
  SCENARIO_MARKER,
} from './group-scenario.ts';

/**
 * Сценарий группы. Проверяется его единственная опора: шаги существуют для
 * Claude только в виде скилла, а триггер — только в виде хука. Всё остальное
 * (поля в state.json) на поведение агента не влияет никак.
 */
describe('Сценарий группы', () => {
  let dir: string;
  let store: AppStore;
  let paths: ClaudePaths;

  const deps = () => ({ paths, store });

  const makeGroup = (patch: Partial<Group>): Group => ({
    id: 'g1',
    name: 'Задача из Jira',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: true,
    order: 0,
    ...patch,
  });

  const scenario = (patch: Partial<NonNullable<Group['scenario']>> = {}) => ({
    when: 'когда прилетел тикет',
    trigger: '',
    steps: [
      { title: 'Забрать тикет', body: 'assign + В работе', gate: 'статус «В работе»' },
      { title: 'Ветка', body: '', gate: '' },
    ],
    ...patch,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-scenario-'));
    mkdirSync(join(dir, 'claude-control'), { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}', 'utf8');
    store = new AppStore(join(dir, 'claude-control'));
    paths = {
      root: dir,
      settings: join(dir, 'settings.json'),
      settingsLocal: join(dir, 'settings.local.json'),
      claudeMd: join(dir, 'CLAUDE.md'),
      secretsEnv: join(dir, '.mcp-secrets.env'),
      skills: join(dir, 'skills'),
      hooks: join(dir, 'hooks'),
      mcpConfig: join(dir, '.claude.json'),
      appData: join(dir, 'claude-control'),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('id скилла с префиксом — чтобы не записать поверх чужого скилла', () => {
    expect(scenarioSkillId(makeGroup({ name: 'Задача из Jira' }))).toBe('scenario-zadacha-iz-jira');
  });

  it('переименование группы не заводит второй скилл', () => {
    const group = makeGroup({
      name: 'Новое имя',
      scenario: scenario({ compiledSkillId: 'scenario-staroe-imya' }),
    });

    expect(scenarioSkillId(group)).toBe('scenario-staroe-imya');
  });

  it('шаги превращаются в скилл: описание, порядок, признаки выполнения', () => {
    const group = makeGroup({ scenario: scenario() });
    const id = compileScenarioSkill(deps(), group);

    expect(id).toBe('scenario-zadacha-iz-jira');

    const text = readFileSync(join(paths.skills, id ?? '', 'SKILL.md'), 'utf8');
    // Описание решает, подключит ли Claude скилл сам, — туда идёт «когда».
    expect(text).toContain('description: когда прилетел тикет');
    expect(text).toContain('### 1. Забрать тикет');
    expect(text).toContain('### 2. Ветка');
    expect(text).toContain('**Готово, когда:** статус «В работе»');
  });

  it('пустой сценарий скилла не заводит', () => {
    const group = makeGroup({ scenario: scenario({ steps: [] }) });

    expect(compileScenarioSkill(deps(), group)).toBeUndefined();
    expect(existsSync(join(paths.skills, 'scenario-zadacha-iz-jira'))).toBe(false);
  });

  it('шаг без названия в скилл не попадает', () => {
    const body = buildScenarioBody(
      makeGroup({}),
      scenario({ steps: [{ title: '', body: 'мусор', gate: '' }] }),
    );

    expect(body).not.toContain('мусор');
  });

  describe('триггер', () => {
    it('годное выражение принимается, негодное — нет', () => {
      expect(isValidTrigger('GOR-\\d+')).toBe(true);
      expect(isValidTrigger('')).toBe(true);
      expect(isValidTrigger('GOR-(\\d+')).toBe(false);
    });

    it('включённая группа с триггером получает хук и скрипт рядом со скиллом', () => {
      const group = makeGroup({ scenario: scenario({ trigger: 'GOR-\\d+' }) });
      compileScenarioSkill(deps(), group);
      store.saveGroup(group);

      compileScenarioHooks(deps());

      const script = join(paths.skills, 'scenario-zadacha-iz-jira', 'trigger.mjs');
      expect(existsSync(script)).toBe(true);
      // Выражение уходит в скрипт как данные: кавычки и слэши в нём — норма.
      expect(readFileSync(script, 'utf8')).toContain('new RegExp("GOR-\\\\d+", \'i\')');

      const hooks = readHooks(paths.settings, store);
      expect(hooks).toHaveLength(1);
      expect(hooks.at(0)?.event).toBe('UserPromptSubmit');
      expect(hooks.at(0)?.command).toContain(`${SCENARIO_MARKER}:g1`);
    });

    it('выключение группы убирает триггер, чужие хуки остаются', () => {
      writeFileSync(
        paths.settings,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'echo руками написанный' }] }],
          },
        }),
        'utf8',
      );

      const group = makeGroup({ scenario: scenario({ trigger: 'GOR-\\d+' }) });
      compileScenarioSkill(deps(), group);
      store.saveGroup(group);
      compileScenarioHooks(deps());
      expect(readHooks(paths.settings, store)).toHaveLength(2);

      store.saveGroup({ ...group, isEnabled: false });
      compileScenarioHooks(deps());

      const hooks = readHooks(paths.settings, store);
      expect(hooks).toHaveLength(1);
      expect(hooks.at(0)?.command).toContain('руками написанный');
    });

    it('сценарий без триггера хука не ставит', () => {
      const group = makeGroup({ scenario: scenario() });
      compileScenarioSkill(deps(), group);
      store.saveGroup(group);

      compileScenarioHooks(deps());

      expect(readHooks(paths.settings, store)).toHaveLength(0);
      expect(existsSync(join(paths.skills, 'scenario-zadacha-iz-jira', 'trigger.mjs'))).toBe(false);
    });
  });
});
