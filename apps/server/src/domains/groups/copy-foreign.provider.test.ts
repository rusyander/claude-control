import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { groupKeyOf } from '@agentdeck/contracts/group-sources';
import { AppStore } from '../../lib/app-store.ts';
import { readGroupSources } from '../../lib/app-store/group-sources.ts';
import { getProvider as provider } from '../../providers/registry.ts';
import { setGroupEnabled } from '../group-toggle.ts';
import { assertBindingKeepsPair, pairsIn } from './choice.ts';
import { copyGroupToGlobal } from './copy.ts';
import { copyGroupToProvider } from './copy-foreign.ts';
import { groupKnobsView, knobsLineForChoice } from './knobs.ts';
import { hookContentId } from '../../lib/hook-id.ts';

/**
 * Копия проектной группы для ЧУЖОГО CLI живёт в его каталогах (F-40): её
 * участники — файлы той CLI, а у Claude может лежать одноимённый скилл — другой
 * файл. Тумблер копии, выбор пары, строка чисел и переопределение Claude её не
 * касаются. Дом чужого CLI — временный (HOME/USERPROFILE), настоящий не трогается.
 */

const savedEnv = { ...process.env };
let home: string;
let root: string;
let project: string;
let store: AppStore;

const deps = () => ({
  store,
  paths: {
    root,
    appData: join(root, 'agentdeck'),
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, 'secrets.env'),
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    mcpConfig: join(root, '.claude.json'),
  },
  backupDir: join(root, 'agentdeck', 'backups'),
});

const skill = (dir: string, id: string, body: string): void => {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(
    join(dir, id, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id} skill\n---\n\n${body}\n`,
    'utf8',
  );
};

function projectGroup(): Group {
  return store.saveGroup({
    id: 'proj-1',
    name: 'Ticket flow',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [{ kind: 'skill', id: 'ladder' }],
    env: {},
    projectPaths: [],
    scope: { kind: 'project', path: project, provider: 'claude' },
    knobs: { 'ladder:review-rounds': 4 },
    isEnabled: true,
    order: 0,
  });
}

const copyToQwen = () =>
  copyGroupToProvider(deps(), projectGroup(), provider('qwen'), provider('claude'), {
    override: root,
  });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-copy-foreign-home-'));
  for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  delete process.env.CLAUDE_CONFIG_DIR;
  root = join(home, '.claude');
  project = join(home, 'proj');
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
  skill(join(project, '.claude', 'skills'), 'ladder', 'Run 2 review rounds.');
  // Тёзка в общих каталогах Claude — другой файл, копия для qwen его не касается.
  skill(join(root, 'skills'), 'ladder', 'Claude own ladder: 3 passes.');
  store = new AppStore(join(root, 'agentdeck'));
});

afterEach(() => {
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('копия для чужого CLI — не глобальная группа Claude', () => {
  it('область копии называет провайдера, выбор пары проекта не переводится на неё', () => {
    const { group } = copyToQwen();
    expect(group.scope).toEqual({ kind: 'global', provider: 'qwen' });
    expect(readGroupSources(join(root, 'agentdeck')).choices).toEqual({});
    expect(pairsIn(store.getGroups(), project)[0]?.global).toBeUndefined();
  });

  it('тумблер копии не гасит одноимённый скилл Claude и не метит его группой', () => {
    const { group } = copyToQwen();
    setGroupEnabled(deps(), group, false);
    expect(existsSync(join(root, 'skills', 'ladder', 'SKILL.md'))).toBe(true);
    expect(store.isDisabled('skill', 'ladder')).toBe(false);
    expect(store.getGroupIdsFor('skill', 'ladder')).not.toContain(group.id);
  });

  it('строка чисел Claude не берётся из копии, числа не выписываются из скилла Claude', () => {
    const { group } = copyToQwen();
    expect(group.knobs).toEqual({ 'ladder:review-rounds': 4 });
    expect(knobsLineForChoice(join(root, 'agentdeck'), store.getGroups(), groupKeyOf(group))).toBe(
      undefined,
    );
    let asked = 0;
    const view = groupKnobsView({
      deps: deps(),
      ask: () => {
        asked += 1;
        return Promise.resolve('');
      },
      prompt: 'p',
      group,
    });
    expect(view.knobs).toEqual([]);
    expect(view.pending).toBeUndefined();
    expect(asked).toBe(0);
  });

  it('копия для qwen не мешает копии в Claude — пара проекта берёт именно её', () => {
    copyToQwen();
    const claude = copyGroupToGlobal(
      deps(),
      store.getGroups().find((g) => g.id === 'proj-1')!,
    );
    expect(pairsIn(store.getGroups(), project)[0]?.global?.id).toBe(claude.group.id);
    expect(Object.values(readGroupSources(join(root, 'agentdeck')).choices)).toEqual([
      { 'proj-1': groupKeyOf(claude.group) },
    ]);
  });

  it('вторая копия для того же чужого CLI — отказ 409', () => {
    copyToQwen();
    expect(() => copyToQwen()).toThrow(/group_already_copied|group-already-copied/);
  });

  it('привязка копии для qwen к проекту оригинала пару не ломает', () => {
    const { group } = copyToQwen();
    expect(() =>
      assertBindingKeepsPair(join(root, 'agentdeck'), store.getGroups(), {
        ...group,
        projectPaths: [project],
      }),
    ).not.toThrow();
  });
});

describe('копия хука в Codex — одобрение в самом CLI (G3)', () => {
  const hookGroup = (): Group => {
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre-tool' }] }] },
      }),
      'utf8',
    );
    return store.saveGroup({
      id: 'proj-hook',
      name: 'Hook flow',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'hook', id: hookContentId('PreToolUse', undefined, 'echo pre-tool') }],
      env: {},
      projectPaths: [],
      scope: { kind: 'project', path: project, provider: 'claude' },
      isEnabled: true,
      order: 0,
    });
  };

  it('Codex: хук лёг, и копия говорит, что без одобрения в /hooks он не заработает', () => {
    const { warnings } = copyGroupToProvider(
      deps(),
      hookGroup(),
      provider('codex'),
      provider('claude'),
      { override: root },
    );
    expect(warnings.filter((warning) => warning.kind === 'skipped')).toEqual([]);
    expect(warnings).toContainEqual(
      expect.objectContaining({ kind: 'approve', detail: provider('codex').name }),
    );
  });

  it('Qwen одобрения не просит — предупреждения нет', () => {
    const { warnings } = copyGroupToProvider(
      deps(),
      hookGroup(),
      provider('qwen'),
      provider('claude'),
      { override: root },
    );
    expect(warnings.some((warning) => warning.kind === 'approve')).toBe(false);
  });
});
