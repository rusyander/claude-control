import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import type { Knob } from '@agentdeck/contracts/group-knobs';
import { AppStore } from '../../lib/app-store.ts';
import {
  projectKey,
  readGroupSources,
  updateGroupSources,
  writePanelJson,
} from '../../lib/app-store/group-sources.ts';
import { getProvider as provider } from '../../providers/registry.ts';
import { adviseCopy, applyAdvice } from './advice.ts';
import { copyGroupToGlobal } from './copy.ts';
import { copyGroupToProvider } from './copy-foreign.ts';
import { groupKnobsLine, KNOBS_EXTRACTION_VERSION } from './knobs.ts';
import { promotePathStep } from './promote.ts';
import { readRules, saveRule } from '../rules.ts';
import { readHooks, readHooksFromFiles } from '../hooks.ts';
import { maskSecretsInText, SECRET_MASK } from '../../lib/secret-mask.ts';
import * as safeIo from '../../lib/safe-io.ts';
import { memberContent } from './members.ts';

/**
 * Числа группы едут вместе с копией: в общие каталоги Claude и к чужому CLI.
 * Только у скиллов, дошедших до цели; переименованный копией — под новым id.
 * Дом чужого CLI — временный (HOME/USERPROFILE), настоящий не трогается.
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

const KNOB: Knob = {
  key: 'review-rounds',
  skillId: 'ladder',
  label: { ru: 'Круги ревью', en: 'Review rounds' },
  default: 2,
  min: 1,
  max: 5,
  quote: 'Run 2 review rounds.',
};

function projectGroup(patch: Partial<Group> = {}): Group {
  return store.saveGroup({
    id: 'proj-1',
    name: 'Ticket flow',
    description: '',
    color: 'accent',
    icon: 'folder',
    // `ghost` — скилла нет на диске: копия его не везёт, и число его — тоже.
    members: [
      { kind: 'skill', id: 'ladder' },
      { kind: 'skill', id: 'ghost' },
    ],
    env: {},
    projectPaths: [],
    scope: { kind: 'project', path: project, provider: 'claude' },
    knobs: { 'ladder:review-rounds': 4, 'ghost:passes': 3 },
    isEnabled: true,
    order: 0,
    ...patch,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-copy-knobs-home-'));
  for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  delete process.env.CLAUDE_CONFIG_DIR;
  root = join(home, '.claude');
  project = join(home, 'proj');
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
  skill(join(project, '.claude', 'skills'), 'ladder', 'Run 2 review rounds.');
  store = new AppStore(join(root, 'agentdeck'));
  // Выписка оригинала уже есть — как после показа чисел на карточке группы.
  const content = memberContent(
    deps(),
    { kind: 'project', path: project, provider: 'claude' },
    {
      kind: 'skill',
      id: 'ladder',
    },
  );
  writePanelJson(join(root, 'agentdeck'), 'skill-knobs.json', {
    [`${projectKey(project)}|skill:ladder`]: {
      hash: content?.hash,
      knobs: [KNOB],
      v: KNOBS_EXTRACTION_VERSION,
    },
  });
});

afterEach(() => {
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('числа группы в копии', () => {
  it('в общие Claude: переименованный скилл — под новым id, строка прогона готова сразу', () => {
    // Имя занято другим общим скиллом: копия ляжет под суффиксом.
    skill(join(root, 'skills'), 'ladder', 'another global ladder');
    const { group, warnings } = copyGroupToGlobal(deps(), projectGroup());
    const renamed = warnings.find((warning) => warning.kind === 'renamed')?.to;
    expect(renamed).toBeTruthy();
    expect(renamed).not.toBe('ladder');
    expect(group.knobs).toEqual({ [`${renamed}:review-rounds`]: 4 });
    // Выписка перенесена к копии: значение действует без новой выписки моделью.
    expect(groupKnobsLine(join(root, 'agentdeck'), group)).toContain(
      `${renamed} — Review rounds: 4 (skill default 2)`,
    );
  });

  // Путь копировался дословно: скилл переименован как раз из-за одноимённого общего,
  // и шаги копии указывали на ЧУЖОЙ общий скилл, а не на свой.
  it('в общие Claude: шаги пути идут за переименованным скиллом', () => {
    skill(join(root, 'skills'), 'ladder', 'another global ladder');
    const text = { ru: 'Шаг', en: 'Step' };
    const step = {
      anchor: 'work' as const,
      title: text,
      prompt: text,
      source: 'ru' as const,
      createdAt: '2026-09-27T00:00:00.000Z',
    };
    const { group, warnings } = copyGroupToGlobal(
      deps(),
      projectGroup({
        path: {
          steps: [
            {
              ...step,
              id: 's1',
              order: 0,
              kind: 'prompt',
              within: { skillId: 'ladder', index: 0, after: '' },
            },
            {
              ...step,
              id: 's2',
              order: 1,
              kind: 'resource',
              resource: { type: 'skill', id: 'ladder' },
            },
            {
              ...step,
              id: 's3',
              order: 2,
              kind: 'resource',
              resource: { type: 'skill', id: 'elsewhere' },
            },
          ],
        },
      }),
    );
    const renamed = warnings.find((warning) => warning.kind === 'renamed')?.to;
    expect(renamed).toBeTruthy();
    const steps = group.path?.steps ?? [];
    expect(steps.map((item) => item.within?.skillId ?? item.resource?.id)).toEqual([
      renamed,
      renamed,
      'elsewhere',
    ]);
  });

  it('к чужому CLI со скиллами: число доехавшего скилла едет, пропавшего — нет', () => {
    const { group } = copyGroupToProvider(
      deps(),
      projectGroup(),
      provider('qwen'),
      provider('claude'),
      { override: root },
    );
    expect(group.knobs).toEqual({ 'ladder:review-rounds': 4 });
  });

  it('к чужому CLI без скиллов: чисел у копии нет — применять их некому', () => {
    const { group, warnings } = copyGroupToProvider(
      deps(),
      projectGroup(),
      provider('gemini'),
      provider('claude'),
      { override: root },
    );
    expect(warnings.some((warning) => warning.kind === 'skipped')).toBe(true);
    expect(group).not.toHaveProperty('knobs');
  });
});

describe('ход пути в копии', () => {
  it('сценарий остаётся сценарием: в общие Claude и к чужому CLI', () => {
    const scenario = projectGroup({ flow: 'scenario' });
    expect(copyGroupToGlobal(deps(), scenario).group.flow).toBe('scenario');
    // Вторая копия той же группы запрещена (F-36) — к чужому CLI едет другая.
    const other = projectGroup({ id: 'proj-2', flow: 'scenario' });
    const foreign = copyGroupToProvider(deps(), other, provider('qwen'), provider('claude'), {
      override: root,
    });
    expect(foreign.group.flow).toBe('scenario');
    expect(
      new AppStore(join(root, 'agentdeck')).getGroups().filter((g) => g.flow === 'scenario'),
    ).toHaveLength(4);
  });

  it('группа без flow копией его не получает', () => {
    expect(copyGroupToGlobal(deps(), projectGroup()).group).not.toHaveProperty('flow');
  });
});

// Совпадающий общий скилл копия не дублирует, а берёт как есть. «Оставить своё»
// удаляло его как созданный копией — а это общий скилл человека, живший до копии.
describe('советы по копии', () => {
  it('«оставить своё» не удаляет общий ресурс, который копия переиспользовала', () => {
    skill(join(root, 'skills'), 'ladder', 'Run 2 review rounds.');
    skill(join(root, 'skills'), 'other', 'other');
    const { group } = copyGroupToGlobal(deps(), projectGroup());
    expect(group.members).toContainEqual({ kind: 'skill', id: 'ladder' });
    updateGroupSources(join(root, 'agentdeck'), (state) => {
      state.advice[group.id] = {
        mode: 'copy',
        items: [
          { kind: 'skill', id: 'ladder', verdict: 'ours', reason: 'r', replacement: 'other' },
        ],
        at: '2026-09-27T00:00:00.000Z',
      };
    });
    const saved = applyAdvice(deps(), group, [{ kind: 'skill', id: 'ladder' }]);
    expect(saved.members).toContainEqual({ kind: 'skill', id: 'other' });
    expect(existsSync(join(root, 'skills', 'ladder', 'SKILL.md'))).toBe(true);
  });

  it('«оставить своё» удаляет то, что копия создала сама', () => {
    skill(join(root, 'skills'), 'ladder', 'another global ladder');
    skill(join(root, 'skills'), 'other', 'other');
    const { group, warnings } = copyGroupToGlobal(deps(), projectGroup());
    const renamed = warnings.find((warning) => warning.kind === 'renamed')?.to ?? '';
    updateGroupSources(join(root, 'agentdeck'), (state) => {
      state.advice[group.id] = {
        mode: 'copy',
        items: [{ kind: 'skill', id: renamed, verdict: 'ours', reason: 'r', replacement: 'other' }],
        at: '2026-09-27T00:00:00.000Z',
      };
    });
    applyAdvice(deps(), group, [{ kind: 'skill', id: renamed }]);
    expect(existsSync(join(root, 'skills', renamed))).toBe(false);
    expect(existsSync(join(root, 'skills', 'ladder', 'SKILL.md'))).toBe(true);
  });
});

// Ревью 28.09 (F-43, F-42, F-363): тёзка в CLAUDE.md сдвигает id соседей при
// каждом разборе — участник чужой группы уезжал на чужое правило.
describe('заголовки правил в копии, совете и продвижении', () => {
  const rule = (title: string, body: string): void => {
    saveRule(join(root, 'CLAUDE.md'), '', { title, body, isEnabled: true, groupIds: [] }, store);
  };
  const titles = (): string[] => readRules(join(root, 'CLAUDE.md'), store).map((r) => r.title);

  it('«улучшить» с заголовком чужого правила — заголовок свой, чужое правило цело', () => {
    rule('Build', 'existing body');
    rule('Other', 'other body');
    const group = store.saveGroup({
      ...projectGroup(),
      id: 'glob-1',
      scope: { kind: 'global' },
      members: [{ kind: 'rule', id: 'other' }],
      knobs: {},
    });
    updateGroupSources(join(root, 'agentdeck'), (state) => {
      state.advice[group.id] = {
        mode: 'copy',
        items: [
          {
            kind: 'rule',
            id: 'other',
            verdict: 'improve',
            reason: 'r',
            replacement: '# Build\n\nimproved',
          },
        ],
        at: '2026-09-28T00:00:00.000Z',
      };
    });
    const saved = applyAdvice(deps(), group, [{ kind: 'rule', id: 'other' }]);
    const rules = readRules(join(root, 'CLAUDE.md'), store);
    expect(rules.find((r) => r.id === 'build')?.body).toBe('existing body');
    expect(rules.find((r) => r.id === 'other')?.body).toBe('improved');
    expect(saved.members).toEqual([{ kind: 'rule', id: 'other' }]);
    expect(titles()).toEqual(['Build', 'Other']);
  });

  it('копия правила с занятым заголовком — «Название (2)», без тёзки', () => {
    rule('Build', 'global body');
    mkdirSync(join(project, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(project, '.claude', 'rules', 'build.md'), '# Build\n\nproject body\n');
    const { group, warnings } = copyGroupToGlobal(
      deps(),
      projectGroup({ members: [{ kind: 'rule', id: 'build' }], knobs: {} }),
    );
    expect(titles()).toEqual(['Build', 'Build (2)']);
    expect(warnings).toContainEqual(expect.objectContaining({ kind: 'renamed', to: 'Build (2)' }));
    const copied = readRules(join(root, 'CLAUDE.md'), store).find((r) => r.title === 'Build (2)');
    expect(group.members).toEqual([{ kind: 'rule', id: copied?.id }]);
    expect(copied?.body).toBe('project body');
  });

  it('продвижение шага в правило с занятым заголовком — отказ 409', () => {
    rule('Build', 'existing body');
    const text = { ru: 'Build', en: 'Build' };
    const group = store.saveGroup({
      ...projectGroup(),
      id: 'glob-2',
      scope: { kind: 'global' },
      members: [],
      knobs: {},
      path: {
        steps: [
          {
            id: 's1',
            order: 0,
            kind: 'prompt',
            anchor: 'work',
            title: text,
            prompt: text,
            source: 'ru',
            createdAt: '2026-09-28T00:00:00.000Z',
          },
        ],
      },
    });
    expect(() =>
      promotePathStep(deps(), group, { stepId: 's1', type: 'rule', draft: 'x' }),
    ).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(titles()).toEqual(['Build']);
  });
});

// Ревью 28.09 (F-362): текст MCP со значениями env/заголовков и команды хуков
// уходили модели и в group-sources.json дословно; обратная сторона — замена
// от модели приходит с маской и не должна лечь на диск маской.
describe('секреты в советах по копии', () => {
  const token = ['plain', 'Value', '123xyz'].join('');
  const copyJira = () => {
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          jira: { command: 'npx', args: ['-y', 'jira-mcp'], env: { JIRA_API_TOKEN: token } },
        },
      }),
    );
    const { group } = copyGroupToGlobal(
      deps(),
      projectGroup({ members: [{ kind: 'mcp', id: 'jira' }], knobs: {} }),
    );
    const text = memberContent(deps(), { kind: 'global' }, { kind: 'mcp', id: 'jira' })?.text ?? '';
    expect(text).toContain(token);
    return { group, text };
  };
  const pend = (groupId: string, replacement: string) =>
    updateGroupSources(join(root, 'agentdeck'), (state) => {
      state.advice[groupId] = {
        mode: 'copy',
        items: [{ kind: 'mcp', id: 'jira', verdict: 'improve', reason: 'r', replacement }],
        at: '2026-09-28T00:00:00.000Z',
      };
    });
  const globalText = () =>
    memberContent(deps(), { kind: 'global' }, { kind: 'mcp', id: 'jira' })?.text ?? '';

  it('модель и файл состояния видят маску, а не значение', async () => {
    const { group, text } = copyJira();
    let asked = '';
    await adviseCopy(
      deps(),
      async (messages) => {
        asked = JSON.stringify(messages);
        return '';
      },
      'prompt',
      group,
      [{ kind: 'mcp', id: 'jira', text }],
    );
    expect(asked).toContain('JIRA_API_TOKEN');
    expect(asked).not.toContain(token);
    expect(readFileSync(join(root, 'agentdeck', 'group-sources.json'), 'utf8')).not.toContain(
      token,
    );
  });

  it('«улучшить» с маской — на диск ложится настоящее значение', () => {
    const { group, text } = copyJira();
    pend(group.id, maskSecretsInText(text).replace('"-y"', '"--yes"'));
    applyAdvice(deps(), group, [{ kind: 'mcp', id: 'jira' }]);
    expect(globalText()).toContain(token);
    expect(globalText()).toContain('--yes');
    expect(globalText()).not.toContain(SECRET_MASK);
  });

  it('маска, которую некуда вернуть, — отказ 409 до записи', () => {
    const { group, text } = copyJira();
    const raw = JSON.parse(text) as { env: Record<string, string> };
    const sent = JSON.stringify({ ...raw, env: { ...raw.env, OTHER_TOKEN: SECRET_MASK } }, null, 2);
    pend(group.id, maskSecretsInText(sent));
    expect(() => applyAdvice(deps(), group, [{ kind: 'mcp', id: 'jira' }])).toThrow(
      expect.objectContaining({ statusCode: 409 }),
    );
    expect(globalText()).toBe(text);
  });
});

// Ревью 28.09 (F-37): замена хука не JSON бросала посреди прохода — скилл уже
// удалён, замены нет; а `{...hook, ...raw}` давал модели переписать служебные поля.
describe('советы по копии: всё или ничего', () => {
  const hookGroup = () => {
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }),
    );
    skill(join(root, 'skills'), 'other', 'other');
    const { group } = copyGroupToGlobal(
      deps(),
      projectGroup({
        members: [
          { kind: 'skill', id: 'ladder' },
          {
            kind: 'hook',
            id: readHooksFromFiles(
              join(project, '.claude', 'settings.json'),
              join(project, '.claude', 'settings.local.json'),
              project,
            )[0]!.id,
          },
        ],
        knobs: {},
      }),
    );
    const hook = group.members.find((member) => member.kind === 'hook')!;
    return { group, hookId: hook.id };
  };
  const pend = (groupId: string, hookId: string, replacement: string) =>
    updateGroupSources(join(root, 'agentdeck'), (state) => {
      state.advice[groupId] = {
        mode: 'copy',
        items: [
          { kind: 'skill', id: 'ladder', verdict: 'ours', reason: 'r', replacement: 'other' },
          { kind: 'hook', id: hookId, verdict: 'improve', reason: 'r', replacement },
        ],
        at: '2026-09-28T00:00:00.000Z',
      };
    });
  const picked = (hookId: string) => [
    { kind: 'skill', id: 'ladder' },
    { kind: 'hook', id: hookId },
  ];

  it('замена не JSON — отказ до первой записи, копия цела', () => {
    const { group, hookId } = hookGroup();
    pend(group.id, hookId, 'run echo better');
    expect(() => applyAdvice(deps(), group, picked(hookId))).toThrow(
      expect.objectContaining({ statusCode: 502 }),
    );
    expect(existsSync(join(root, 'skills', 'ladder', 'SKILL.md'))).toBe(true);
    expect(store.getGroups().find((item) => item.id === group.id)?.members).toEqual(group.members);
    expect(readGroupSources(join(root, 'agentdeck')).advice[group.id]?.items).toHaveLength(2);
  });

  it('замена хука не переписывает служебные поля', () => {
    const { group, hookId } = hookGroup();
    pend(
      group.id,
      hookId,
      JSON.stringify({ event: 'Stop', command: 'echo better', isEnabled: false, source: 'x' }),
    );
    applyAdvice(deps(), group, [{ kind: 'hook', id: hookId }]);
    const hook = readHooks(join(root, 'settings.json'), store).find(
      (item) => item.command === 'echo better',
    );
    expect(hook?.isEnabled).toBe(true);
    expect(hook?.source).not.toBe('x');
  });
});

// Ревью 28.09 (F-36): вторая копия той же группы — выбор ставился на неё, а пара
// брала первую глобальную с тем же origin, и проект откатывался к проектной.
describe('повторная копия той же группы', () => {
  it('в общие Claude — отказ 409, копия одна, выбор на ней', () => {
    const first = copyGroupToGlobal(deps(), projectGroup()).group;
    expect(() => copyGroupToGlobal(deps(), projectGroup())).toThrow(
      expect.objectContaining({ statusCode: 409, messageCode: 'group-already-copied' }),
    );
    const copies = store.getGroups().filter((item) => item.origin?.groupId === 'proj-1');
    expect(copies.map((item) => item.id)).toEqual([first.id]);
    expect(readGroupSources(join(root, 'agentdeck')).choices[projectKey(project)]).toEqual({
      'proj-1': `global:${first.id}`,
    });
  });

  // F-40: копия для другой CLI живёт в её каталогах и стороной пары не бывает —
  // рядом с копией в Claude она не вторая. Вторая копия для ТОЙ ЖЕ CLI — отказ.
  it('к чужому CLI после копии в общие — можно, пара и выбор остаются за копией Claude', () => {
    const claude = copyGroupToGlobal(deps(), projectGroup()).group;
    const qwen = copyGroupToProvider(deps(), projectGroup(), provider('qwen'), provider('claude'), {
      override: root,
    }).group;
    expect(qwen.scope).toEqual({ kind: 'global', provider: 'qwen' });
    expect(readGroupSources(join(root, 'agentdeck')).choices[projectKey(project)]).toEqual({
      'proj-1': `global:${claude.id}`,
    });
    expect(() =>
      copyGroupToProvider(deps(), projectGroup(), provider('qwen'), provider('claude'), {
        override: root,
      }),
    ).toThrow(expect.objectContaining({ statusCode: 409, messageCode: 'group-already-copied' }));
  });
});

// Ревью 28.09 (F-41): копировщик бросал посреди прохода — записанное раньше
// оставалось в общих без группы, выбор не переключался, предупреждения не было.
describe('сбой копировщика посреди копии', () => {
  it('участник не скопировался — предупреждение, группа всё равно сохранена', () => {
    vi.spyOn(safeIo, 'copyRecursive').mockImplementation(() => {
      throw new Error('EPERM');
    });
    const { group, warnings } = copyGroupToGlobal(deps(), projectGroup());
    vi.restoreAllMocks();
    expect(warnings).toContainEqual({ kind: 'failed', member: 'skill:ladder', detail: 'EPERM' });
    expect(store.getGroups().some((item) => item.id === group.id)).toBe(true);
    expect(readGroupSources(join(root, 'agentdeck')).choices[projectKey(project)]).toEqual({
      'proj-1': `global:${group.id}`,
    });
  });
});
