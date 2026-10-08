import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import type { StoredChatGroupSettings } from '@agentdeck/contracts/chat-group-settings';
import {
  applySplitPlan,
  parseSplitPlan,
  SPLIT_PLAN_BLOCK_LANG,
  triageStagePrompt,
  type TriageGroupCatalogEntry,
} from '@agentdeck/contracts/split-plan';
import type { TaskSplitResult } from '@agentdeck/contracts/task-split';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { projectKey, updateGroupSources } from '../../../lib/app-store/group-sources.ts';
import type { ChatEvent } from '../ChatRunner/ChatRunner.ts';
import type { ChatTreeReader } from '../chat-autonomy/chat-autonomy.ts';
import {
  activateEffectiveGroup,
  pickableGroups,
  type PickProject,
  triageGroupCatalog,
  writePickedGroup,
} from './group-auto-pick.ts';
import { sandboxRoot } from '../ChatArtifacts/ChatArtifacts.ts';
import { SplitConveyor } from '../split-conveyor/split-conveyor.ts';

/**
 * Автовыбор группы разбором (выбор чата — `auto`): что разбор видит в
 * каталоге, когда он не выбирает вовсе, что делается с выдуманным ключом и что
 * ложится ребёнку. Конвейер — настоящий, запуск и разбор — колбэки.
 */

const group = (patch: Partial<Group>): Group =>
  ({
    id: 'g',
    name: 'Набор',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: false,
    order: 0,
    when: '',
    ...patch,
  }) as Group;

const PROJECT = 'C:/work/repo';
const inProject = { kind: 'project', path: PROJECT, provider: 'claude' } as const;

const GROUPS: Group[] = [
  group({ id: 'review', name: 'Review loop', when: 'reviewing a merge request' }),
  group({ id: 'bare', name: 'Bare' }),
  group({ id: 'mine', name: 'Project flow', scope: inProject, when: 'any task here' }),
  group({
    id: 'mine-copy',
    name: 'Project flow (copy)',
    origin: { groupId: 'mine', scope: inProject, hash: 'h' },
  } as Partial<Group>),
  group({
    id: 'other',
    name: 'Other project',
    scope: { kind: 'project', path: 'C:/work/other', provider: 'claude' },
  }),
];

const tree = (
  own: Record<string, StoredChatGroupSettings>,
  parents: Record<string, string> = {},
): ChatTreeReader => ({ own: (key) => own[key], parentOf: (key) => parents[key] });

describe('блок разбора несёт выбор группы', () => {
  it('groupKey разбирается и доезжает до применения; старый блок без него годится', () => {
    const plan = parseSplitPlan(
      { groups: [{ index: 1, groupKey: ' global:review ' }, { index: 2 }] },
      ['Раз', 'Два'],
    );
    expect(plan?.groups[0]?.groupKey).toBe('global:review');
    expect(plan?.groups[1]).not.toHaveProperty('groupKey');
    const applied = applySplitPlan(
      [
        { title: 'Раз', tasks: ['a'] },
        { title: 'Два', tasks: ['b'] },
      ],
      plan!,
    );
    expect(applied.groups[0]?.groupKey).toBe('global:review');
    expect(applied.groups[1]).not.toHaveProperty('groupKey');
  });

  it('каталог — в промпте разбора по-английски; группа без when — одним именем', () => {
    const catalog: TriageGroupCatalogEntry[] = [
      { key: 'global:review', name: 'Review loop', when: 'reviewing a merge request' },
      { key: 'global:bare', name: 'Bare' },
    ];
    const groups = [{ title: 'Раз', branch: 'feature/one', tasks: ['a'] }];
    const prompt = triageStagePrompt({ groups, catalog });
    expect(prompt).toContain('pick one ONLY when its "when" clearly fits');
    expect(prompt).toContain('- global:review — Review loop — when: reviewing a merge request');
    expect(prompt).toMatch(/^- global:bare — Bare$/m);
    expect(prompt).toContain('"groupKey"');
    expect(triageStagePrompt({ groups })).not.toContain('Panel group catalog');
  });
});

describe('каталог групп для разбора', () => {
  it('глобальные и группы этого проекта; из пары — только действующая', () => {
    const keys = (choice: Parameters<typeof pickableGroups>[2]) =>
      pickableGroups(GROUPS, PROJECT, choice).map((entry) => entry.key);
    // Выбора пары нет — действует проектная, её глобальная копия в каталог не идёт.
    expect(keys(null)).toEqual(['global:review', 'global:bare', 'project:mine']);
    // Выбрана копия — наоборот.
    expect(keys('global:mine-copy')).toEqual(['global:review', 'global:bare', 'global:mine-copy']);
  });

  it('глобальная копия для другой CLI в каталог не идёт: чат Claude её не включит (F-40)', () => {
    const foreign = group({
      id: 'mine-qwen',
      name: 'Project flow (qwen)',
      scope: { kind: 'global', provider: 'qwen' },
    });
    const keys = pickableGroups([...GROUPS, foreign], PROJECT, null).map((entry) => entry.key);
    expect(keys).toEqual(['global:review', 'global:bare', 'project:mine']);
  });

  it('when — только непустой', () => {
    const entries = pickableGroups(GROUPS, PROJECT, null);
    expect(entries[0]).toEqual({
      key: 'global:review',
      name: 'Review loop',
      when: 'reviewing a merge request',
    });
    expect(entries[1]).toEqual({ key: 'global:bare', name: 'Bare' });
  });

  it('сценарий помечен в каталоге и в промпте разбора: его шаги — вся работа группы', () => {
    const scenario = group({
      id: 'steps',
      name: 'Release',
      when: 'cutting a release',
      flow: 'scenario',
    });
    const entries = pickableGroups([...GROUPS, scenario], PROJECT, null);
    expect(entries.find((entry) => entry.key === 'global:steps')).toEqual({
      key: 'global:steps',
      name: 'Release',
      when: 'cutting a release',
      scenario: true,
    });
    expect(entries.find((entry) => entry.key === 'global:review')).not.toHaveProperty('scenario');
    const prompt = triageStagePrompt({
      groups: [{ title: 'Раз', branch: 'feature/one', tasks: ['a'] }],
      catalog: entries,
    });
    expect(prompt).toContain(
      '- global:steps — Release — when: cutting a release — scenario: its steps, in order, are the whole work of the group',
    );
    expect(prompt).toContain('- global:review — Review loop — when: reviewing a merge request\n');
  });

  it('явная группа родителя или его родителя — разбор не выбирает', () => {
    const catalog = (reader: ChatTreeReader) =>
      triageGroupCatalog({
        reader,
        groups: GROUPS,
        pairChoice: null,
        parentChatId: 'parent',
        projectPath: PROJECT,
      });
    expect(catalog(tree({}))?.map((entry) => entry.key)).toContain('global:review');
    expect(catalog(tree({ parent: { groupChoice: 'global:bare' } }))).toBeUndefined();
    expect(
      catalog(tree({ root: { groupChoice: 'global:bare' } }, { parent: 'root' })),
    ).toBeUndefined();
  });
});

describe('выбор ложится ребёнку', () => {
  let dir: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-auto-pick-'));
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    store = new AppStore(join(dir, 'agentdeck'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('у ребёнка под auto — своим выбором, своё прочее не теряется', () => {
    store.setChatLink('new-1-0', { parentChatId: 'parent', createdAt: '2026-09-26T00:00:00Z' });
    store.setChatGroupSettings('new-1-0', { autonomous: false });
    expect(writePickedGroup(store, 'new-1-0', 'global:review')).toBe('global:review');
    expect(store.getChatGroupSettings('new-1-0')).toEqual({
      autonomous: false,
      groupChoice: 'global:review',
    });
  });

  it('F-107: неактивная сторона пары на запуске заменяется действующей той же пары', () => {
    const project: PickProject = {
      groups: GROUPS,
      projectPath: PROJECT,
      pairChoice: 'global:mine-copy',
    };
    store.setChatLink('new-1-0', { parentChatId: 'parent', createdAt: '2026-09-26T00:00:00Z' });
    expect(writePickedGroup(store, 'new-1-0', 'project:mine', project)).toBe('global:mine-copy');
    expect(store.getChatGroupSettings('new-1-0')?.groupChoice).toBe('global:mine-copy');
    // Действующая сторона и группа вне пары — как выбраны.
    expect(writePickedGroup(store, 'new-2-0', 'global:mine-copy', project)).toBe(
      'global:mine-copy',
    );
    expect(writePickedGroup(store, 'new-3-0', 'global:review', project)).toBe('global:review');
    // Без выбора пары действует проектная — глобальная копия уступает ей.
    expect(
      writePickedGroup(store, 'new-4-0', 'global:mine-copy', { ...project, pairChoice: null }),
    ).toBe('project:mine');
  });

  it('явный выбор родителя сильнее разбора; мусорный ключ не пишется', () => {
    store.setChatLink('new-1-0', { parentChatId: 'parent', createdAt: '2026-09-26T00:00:00Z' });
    store.setChatGroupSettings('parent', { groupChoice: 'global:bare' });
    expect(writePickedGroup(store, 'new-1-0', 'global:review')).toBeUndefined();
    expect(store.getChatGroupSettings('new-1-0')).toBeUndefined();
    expect(writePickedGroup(store, 'new-2-0', 'review')).toBeUndefined();
    expect(store.getChatGroupSettings('new-2-0')).toBeUndefined();
  });
});

/**
 * Включение выбранной группы на старте: один вопрос реестра и службы чужих CLI.
 * Выбор — действующий (свой или унаследованный), песочница не трогается.
 */
describe('включение выбранной группы на старте', () => {
  let dir: string;
  let store: AppStore;
  const deps = () => ({
    store,
    paths: {
      root: dir,
      appData: join(dir, 'agentdeck'),
      settings: join(dir, 'settings.json'),
      settingsLocal: join(dir, 'settings.local.json'),
      claudeMd: join(dir, 'CLAUDE.md'),
      secretsEnv: join(dir, 'secrets.env'),
      skills: join(dir, 'skills'),
      hooks: join(dir, 'hooks'),
      mcpConfig: join(dir, '.claude.json'),
    },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-activate-'));
    mkdirSync(join(dir, 'agentdeck'), { recursive: true });
    store = new AppStore(join(dir, 'agentdeck'));
    store.saveGroup(group({ id: 'x', name: 'Набор X' }));
    store.setChatGroupSettings('parent', { groupChoice: 'global:x' });
    store.setChatLink('child', { parentChatId: 'parent', createdAt: '2026-09-26T00:00:00Z' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const enabled = () => store.getGroups().find((one) => one.id === 'x')?.isEnabled;

  it('ребёнок без своего выбора включает группу родителя', () => {
    expect(activateEffectiveGroup(deps(), ['child'], dir)).toBe('Набор X');
    expect(enabled()).toBe(true);
    // Уже включённая — второй заметки нет.
    expect(activateEffectiveGroup(deps(), ['child'], dir)).toBeUndefined();
  });

  /**
   * F-107, остаток (V-fix-A): закрепление, сделанное, пока его сторона пары
   * была действующей, переживает смену стороны. Старт прогона всё равно
   * включал неактивную глобальную половину поверх действующей проектной —
   * ровно тот вред, от которого закрывали меню и разбор. Закрепление
   * неактивной половины разрешается в действующую (или ни во что).
   */
  it('закреплённая неактивная половина пары не включается: ложится действующая', () => {
    const scope = { kind: 'project', path: dir, provider: 'claude' } as const;
    store.saveGroup(group({ id: 'mine', name: 'Проектный', scope, order: 1 }));
    store.saveGroup(
      group({
        id: 'mine-copy',
        name: 'Глобальная копия',
        origin: { groupId: 'mine', scope, hash: 'h' },
        order: 2,
      } as Partial<Group>),
    );
    store.setChatGroupSettings('pinned', { groupChoice: 'global:mine-copy' });
    const copyEnabled = () => store.getGroups().find((one) => one.id === 'mine-copy')?.isEnabled;

    // Выбора стороны нет — действует проектная: включать нечего.
    expect(activateEffectiveGroup(deps(), ['pinned'], dir)).toBeUndefined();
    expect(copyEnabled()).toBe(false);

    // Человек выбрал глобальную сторону — та же закреплённая включается.
    updateGroupSources(join(dir, 'agentdeck'), (state) => {
      state.choices[projectKey(dir)] = 'global:mine-copy';
    });
    expect(activateEffectiveGroup(deps(), ['pinned'], dir)).toBe('Глобальная копия');
    expect(copyEnabled()).toBe(true);
  });

  /**
   * Ребёнок разделения идёт в копии репозитория (`git worktree`), и выбор
   * стороны пары записан на ОСНОВНОЙ проект: по каталогу копии его не найти, и
   * закреплённая неактивная глобальная включалась бы (V-fix-D, F-107).
   * Настоящий репозиторий и настоящая копия — `layoutForCwd` читает `.git`.
   */
  it('старт в копии репозитория сверяет пару основного проекта', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-pin-wt-')));
    try {
      const repo = join(root, 'repo');
      mkdirSync(repo);
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, encoding: 'utf8' });
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'p@example.com');
      git(repo, 'config', 'user.name', 'p');
      writeFileSync(join(repo, 'a.txt'), 'x\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'one');
      const copy = join(root, 'repo-wt');
      git(repo, 'worktree', 'add', '-q', '-b', 'feat', copy);

      const scope = { kind: 'project', path: repo, provider: 'claude' } as const;
      store.saveGroup(group({ id: 'mine', name: 'Проектный', scope, order: 1 }));
      store.saveGroup(
        group({
          id: 'mine-copy',
          name: 'Глобальная копия',
          origin: { groupId: 'mine', scope, hash: 'h' },
          order: 2,
        } as Partial<Group>),
      );
      store.setChatGroupSettings('pinned', { groupChoice: 'global:mine-copy' });
      const copyEnabled = () => store.getGroups().find((one) => one.id === 'mine-copy')?.isEnabled;

      // Действует проектная сторона основного проекта — в копии включать нечего.
      expect(activateEffectiveGroup(deps(), ['pinned'], copy)).toBeUndefined();
      expect(copyEnabled()).toBe(false);

      // Сторону выбрали на основном проекте — копия видит тот же выбор.
      updateGroupSources(join(dir, 'agentdeck'), (state) => {
        state.choices[projectKey(repo)] = 'global:mine-copy';
      });
      expect(activateEffectiveGroup(deps(), ['pinned'], copy)).toBe('Глобальная копия');
      expect(copyEnabled()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('песочница и старт без каталога группу не трогают', () => {
    expect(activateEffectiveGroup(deps(), ['child'], join(sandboxRoot(), 'c1'))).toBeUndefined();
    expect(activateEffectiveGroup(deps(), ['child'], undefined)).toBeUndefined();
    expect(enabled()).toBe(false);
  });
});

describe('конвейер: выбор разбора сверяется с каталогом', () => {
  const CATALOG: TriageGroupCatalogEntry[] = [
    { key: 'global:review', name: 'Review loop', when: 'reviewing a merge request' },
  ];
  const PROPOSAL = {
    groups: [
      { title: 'Раз', branch: 'feature/one', tasks: ['первая'] },
      { title: 'Два', branch: 'feature/two', tasks: ['вторая'] },
    ],
  };

  function build(catalog: TriageGroupCatalogEntry[] | undefined) {
    const records = new Map<string, SplitPlanRecord>();
    const prompts: string[] = [];
    const launched: SplitPlanRecord[] = [];
    const logs: string[] = [];
    const notices: { parent: string; event: ChatEvent }[] = [];
    const conveyor = new SplitConveyor({
      store: {
        get: (parent) => records.get(parent),
        set: (record) => void records.set(record.parentChatId, structuredClone(record)),
        findByTriage: (ids) =>
          [...records.values()].find((record) => ids.includes(record.triageChatId ?? '')),
        all: () => Object.fromEntries(records),
      },
      groupCatalog: () => catalog,
      launch: async (record, groups): Promise<TaskSplitResult> => {
        launched.push(structuredClone(record));
        return {
          chats: groups.map((index) => ({
            index,
            title: record.proposal.groups[index]?.title ?? '',
            branch: record.groups[index]?.branch ?? '',
            chatId: `new-${index}`,
            path: `C:/copies/${index}`,
            isWorktree: true,
            started: true,
            prompt: '',
          })),
          failures: [],
        };
      },
      startTriage: (_record, prompt) => {
        prompts.push(prompt);
        return { chatId: 'new-triage', started: true, deferred: false };
      },
      notify: (parent, event) => void notices.push({ parent, event }),
      log: (message) => void logs.push(message),
    });
    const triage = (json: unknown) =>
      conveyor.onTriageFinished(
        {
          ok: true,
          text: ['Развёл.', '```' + SPLIT_PLAN_BLOCK_LANG, JSON.stringify(json), '```'].join('\n'),
        },
        ['new-triage'],
      );
    const begin = () =>
      conveyor.begin({
        parentChatId: 'parent',
        projectPath: 'C:/repo',
        proposal: structuredClone(PROPOSAL),
        request: {},
      });
    return { records, prompts, launched, logs, notices, triage, begin };
  }

  const wait = () => new Promise((done) => setTimeout(done, 5));

  it('каталог уходит в промпт разбора и в запись', async () => {
    const run = build(CATALOG);
    await run.begin();
    expect(run.prompts[0]).toContain('- global:review — Review loop');
    expect(run.records.get('parent')?.groupCatalog).toEqual([
      { key: 'global:review', name: 'Review loop' },
    ]);
  });

  it('знакомый ключ — группе и в ленту родителя кодом; выдуманный — отброшен с записью', async () => {
    const run = build(CATALOG);
    await run.begin();
    const event = run.triage({
      groups: [
        { index: 1, groupKey: 'global:review' },
        { index: 2, groupKey: 'global:invented' },
      ],
    });
    await wait();

    const record = run.records.get('parent')!;
    expect(record.proposal.groups[0]?.groupKey).toBe('global:review');
    expect(record.proposal.groups[1]).not.toHaveProperty('groupKey');
    // Запуск видит выбор в той записи, из которой заводит детей.
    expect(run.launched[0]?.proposal.groups[0]?.groupKey).toBe('global:review');
    expect(run.logs.some((line) => line.includes('global:invented'))).toBe(true);

    expect(run.notices).toEqual([
      {
        parent: 'parent',
        event: {
          kind: 'notice',
          code: 'triageApplied',
          text: 'Разбор выбрал группы панели: «Раз» → Review loop.',
          textCode: 'split-triage-groups-picked-notice',
          textParams: { picks: '«Раз» → Review loop' },
        },
      },
    ]);
    expect(event && 'text' in event ? event.text : '').toContain('«Раз» → Review loop');
  });

  it('без каталога (явная группа родителя) выбор в блоке ничего не значит', async () => {
    const run = build(undefined);
    await run.begin();
    expect(run.prompts[0]).not.toContain('Panel group catalog');
    expect(run.records.get('parent')).not.toHaveProperty('groupCatalog');
    run.triage({ groups: [{ index: 1, groupKey: 'global:review' }] });
    await wait();
    expect(run.records.get('parent')?.proposal.groups[0]).not.toHaveProperty('groupKey');
    expect(run.notices).toEqual([]);
  });
});
