import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudePaths, Group } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { readHooks } from '../hooks/hooks.ts';
import {
  buildScenarioBody,
  isValidTrigger,
  retireScenarioHooks,
  SCENARIO_MARKER,
} from './group-scenario.ts';
import { migrateGroupPaths, migrateGroupRecord } from '../groups/path-migration.ts';
import { setGroupEnabled } from '../group-toggle.ts';

/**
 * Старый «Порядок работы» после переезда в «Путь»: шаги переносятся в
 * `path.steps`, скомпилированный скилл удаляется только нетронутым (с копией),
 * хуки-триггеры снимаются, а повторный запуск ничего не пишет.
 */
describe('Сценарий группы → Путь', () => {
  let dir: string;
  let store: AppStore;
  let paths: ClaudePaths;

  const deps = () => ({ paths, store, backupDir: join(dir, 'backups') });

  const scenario = {
    when: 'когда прилетел тикет',
    trigger: 'PRJ-\\d+',
    steps: [
      { title: 'Забрать тикет', body: 'assign + В работе', gate: 'статус «В работе»' },
      { title: 'Ветка', body: '', gate: '' },
    ],
    compiledSkillId: 'scenario-zadacha',
  };

  const makeGroup = (patch: Partial<Group> = {}): Group => ({
    id: 'g1-aaaaaaaa',
    name: 'Задача из трекера',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [{ kind: 'skill', id: 'scenario-zadacha' }],
    env: {},
    projectPaths: [],
    isEnabled: true,
    order: 0,
    scenario,
    ...patch,
  });

  /** Скомпилированный скилл ровно таким, каким его собирала старая панель. */
  const writeCompiledSkill = (group: Group, extraBody = ''): string => {
    const skillDir = join(paths.skills, 'scenario-zadacha');
    mkdirSync(skillDir, { recursive: true });
    const body = buildScenarioBody(group, group.scenario!) + extraBody;
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: x\ndescription: y\n---\n\n${body}\n`);
    return skillDir;
  };

  const trigger = {
    type: 'command',
    command: `node "x/trigger.mjs" ${SCENARIO_MARKER} g1`,
  };
  const manual = { type: 'command', command: 'echo manual' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-scenario-'));
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [trigger, manual] }] } }),
      'utf8',
    );
    store = new AppStore(join(dir, 'agentdeck'));
    paths = {
      root: dir,
      settings: join(dir, 'settings.json'),
      settingsLocal: join(dir, 'settings.local.json'),
      claudeMd: join(dir, 'CLAUDE.md'),
      secretsEnv: join(dir, '.mcp-secrets.env'),
      skills: join(dir, 'skills'),
      hooks: join(dir, 'hooks'),
      mcpConfig: join(dir, '.claude.json'),
      appData: join(dir, 'agentdeck'),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('выражение триггера по-прежнему проверяется', () => {
    expect(isValidTrigger('PRJ-\\d+')).toBe(true);
    expect(isValidTrigger('PRJ-(\\d+')).toBe(false);
  });

  it('снимает только свои хуки-триггеры, ручной остаётся', () => {
    retireScenarioHooks(deps());
    const commands = readHooks(paths.settings, store).map((hook) => hook.command);
    expect(commands).toEqual(['echo manual']);
  });

  // Ревью 28.09 (F-219): щелчок группы снимал триггер с записью settings.json и
  // копией, а итог щелчка копию не называл — откатить было не по чему.
  it('щелчок группы, снявший триггер, называет копию settings.json', () => {
    const result = setGroupEnabled(deps(), makeGroup({ members: [], scenario: undefined }), false);
    expect(result.backupPath).toBeTruthy();
    expect(existsSync(result.backupPath!)).toBe(true);
  });

  it('без триггеров settings.json не переписывается', () => {
    writeFileSync(paths.settings, '{ "hooks": {} }', 'utf8');
    retireScenarioHooks(deps());
    expect(readFileSync(paths.settings, 'utf8')).toBe('{ "hooks": {} }');
  });

  it('шаги уходят в путь после work, с меткой перевода и признаком выполнения', () => {
    const next = migrateGroupRecord(makeGroup(), '2026-09-26T00:00:00.000Z');
    const steps = next?.group.path?.steps ?? [];
    expect(steps.map((step) => step.title.ru)).toEqual(['Забрать тикет', 'Ветка']);
    expect(steps.every((step) => step.anchor === 'work' && step.needsTranslation)).toBe(true);
    expect(steps[0]?.gate?.ru).toBe('статус «В работе»');
    expect(steps[1]?.gate).toBeUndefined();
    expect(next?.compiledSkillId).toBe('scenario-zadacha');
  });

  it('нетронутый скилл удаляется с копией и уходит из участников; сценарий читаем', () => {
    const group = makeGroup();
    store.saveGroup(group);
    writeCompiledSkill(group);

    const report = migrateGroupPaths(deps());

    expect(report.removedSkills).toEqual(['scenario-zadacha']);
    expect(existsSync(join(paths.skills, 'scenario-zadacha'))).toBe(false);
    expect(existsSync(join(dir, 'backups'))).toBe(true);
    const saved = store.getGroups()[0]!;
    expect(saved.members).toEqual([]);
    expect(saved.scenario?.steps).toHaveLength(2);
    expect(saved.path?.steps).toHaveLength(2);
    expect(readHooks(paths.settings, store).map((hook) => hook.command)).toEqual(['echo manual']);
  });

  it('правленный руками скилл остаётся на месте и участником', () => {
    const group = makeGroup();
    store.saveGroup(group);
    writeCompiledSkill(group, '\n\nМоя приписка.');

    const report = migrateGroupPaths(deps());

    expect(report.keptSkills).toEqual(['scenario-zadacha']);
    expect(existsSync(join(paths.skills, 'scenario-zadacha', 'SKILL.md'))).toBe(true);
    expect(store.getGroups()[0]?.members).toEqual([{ kind: 'skill', id: 'scenario-zadacha' }]);
  });

  it('повторный запуск ничего не пишет', () => {
    store.saveGroup(makeGroup());
    migrateGroupPaths(deps());
    const settingsBefore = readFileSync(paths.settings, 'utf8');
    const stateBefore = JSON.stringify(store.getGroups());

    const report = migrateGroupPaths(deps());

    expect(report.migrated).toEqual([]);
    expect(readFileSync(paths.settings, 'utf8')).toBe(settingsBefore);
    expect(JSON.stringify(store.getGroups())).toBe(stateBefore);
  });

  it('группа без сценария не трогается', () => {
    store.saveGroup(makeGroup({ scenario: undefined, members: [] }));
    expect(migrateGroupPaths(deps()).migrated).toEqual([]);
    expect(store.getGroups()[0]?.path).toBeUndefined();
  });
});
