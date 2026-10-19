import { describe, it, expect } from 'vitest';
import { OWNER_PRECEDENCE_LINE } from '@agentdeck/contracts/quality-floor';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../../lib/app-store/app-store.types.ts';
import {
  createRecheckSession,
  readRecheckScope,
  recheckFreshBrief,
  type RecheckSessionDeps,
  type RecheckStart,
} from './recheck-session.ts';

/**
 * «Перепроверить MR» новым разговором (R2/R5, 19.10.2026). Снаружи подменены
 * только хранилище связей, старт процесса, прежний путь (`resume`), git и часы —
 * решение, когда идти новым разговором, а когда прежним, проверяется настоящее.
 */

const NOW = Date.parse('2026-10-19T21:00:00.000Z');

const group = (extra: Partial<SplitPlanGroupRecord> = {}): SplitPlanGroupRecord => ({
  index: 1,
  title: 'Фронт',
  branch: 'feat/a',
  after: [],
  status: 'done',
  deliver: true,
  chatId: 'old-session',
  path: 'C:/wt/front',
  mr: 'https://git.acme.local/team/app/-/merge_requests/7',
  ...extra,
});

const record = (tasks: string[] = ['PROJ-1 кнопка']): SplitPlanRecord => ({
  parentChatId: 'parent',
  projectPath: 'C:/repo',
  createdAt: '2026-10-19T09:00:00.000Z',
  order: [0, 1],
  request: {},
  proposal: {
    groups: [
      { title: 'Бэк', branch: 'feat/b', tasks: ['PROJ-0'] },
      { title: 'Фронт', branch: 'feat/a', tasks },
    ],
  },
  groups: [group({ index: 0, chatId: 'other' }), group()],
});

const link = (extra: Partial<ChatLink> = {}): ChatLink => ({
  parentChatId: 'parent',
  title: 'Фронт',
  groupIndex: 1,
  conversation: 'old-session',
  createdAt: '2026-10-19T09:05:00.000Z',
  model: 'opus',
  effort: 'high',
  stage: 'build',
  ...extra,
});

function harness(
  options: {
    links?: Record<string, ChatLink>;
    running?: string[];
    start?: RecheckStart;
  } = {},
) {
  const links: Record<string, ChatLink> = options.links ?? { 'old-session': link() };
  const starts: Parameters<RecheckStart>[0][] = [];
  const resumed: string[] = [];
  const removed: string[] = [];
  const logs: string[] = [];
  const deps: RecheckSessionDeps = {
    links: () => links,
    setLink: (key, value) => {
      links[key] = value;
    },
    removeLink: (key) => {
      removed.push(key);
      delete links[key];
    },
    running: (key) => (options.running ?? []).includes(key),
    start:
      options.start ??
      ((input) => {
        starts.push(input);
        return { started: true };
      }),
    resume: (_group, prompt) => {
      resumed.push(prompt);
      return 'sent';
    },
    progress: () => true,
    now: () => NOW,
    log: (message) => logs.push(message),
  };
  return { deps, links, starts, resumed, removed, logs, send: createRecheckSession(deps) };
}

describe('вводная нового разговора перепроверки', () => {
  it('новый разговор, прежний id, ветка, копия, MR; PROGRESS — контекст, не задачи', () => {
    const brief = recheckFreshBrief({
      previous: 'old-session',
      group: group(),
      tasks: [],
      progress: true,
    });
    expect(brief).toContain('NEW conversation of the split group «Фронт»');
    expect(brief).toContain('(old-session) stays in the chat history');
    expect(brief).toContain('Branch feat/a, working copy C:/wt/front, MR https://git.acme.local/');
    expect(brief).toContain(
      '.agent/PROGRESS.md in the copy — context of the earlier work, not tasks',
    );
  });

  it('задание из связи дословно, строка старшинства ровно одна', () => {
    const brief = recheckFreshBrief({
      previous: 'old-session',
      group: group(),
      task: 'Сделать кнопку синей',
      tasks: ['PROJ-1 из предложения'],
      progress: false,
    });
    expect(brief).toContain("The group's task, as it was given:\nСделать кнопку синей");
    expect(brief).not.toContain('PROJ-1 из предложения');
    expect(brief).not.toContain('PROGRESS.md');
    expect(brief.split(OWNER_PRECEDENCE_LINE).length - 1).toBe(1);
  });

  it('связи без задания — задачи из предложения списком', () => {
    const brief = recheckFreshBrief({
      previous: 'old-session',
      group: group({ path: undefined, mr: undefined }),
      tasks: ['PROJ-1', 'PROJ-2'],
      progress: false,
    });
    expect(brief).toContain("The group's tasks:\n- PROJ-1\n- PROJ-2");
    expect(brief).toContain('working copy —, MR —');
  });
});

describe('охват перепроверки по копии', () => {
  it('файлы ветки против цели; мимо охвата — грязные файлы вне её, без повторов', async () => {
    const calls: { cwd: string; args: string[] }[] = [];
    const scope = await readRecheckScope(
      { mainDir: 'C:/repo', copy: 'C:/wt/front', base: 'main' },
      async (cwd, args) => {
        calls.push({ cwd, args });
        if (args[0] === 'diff') return 'web/Button.tsx\0web/Button.css\0';
        // Своя правка в охвате, чужой go.mod дважды (изменён и в индексе), переименование.
        return ' M web/Button.tsx\0 M svc/go.mod\0M  svc/go.mod\0R  new.ts\0old.ts\0';
      },
    );
    expect(scope).toEqual({
      base: 'main',
      files: ['web/Button.tsx', 'web/Button.css'],
      outside: ['svc/go.mod', 'new.ts', 'old.ts'],
    });
    expect(calls.every((call) => call.cwd === 'C:/wt/front')).toBe(true);
    expect(calls.find((call) => call.args[0] === 'diff')?.args).toContain('main...HEAD');
  });
});

describe('слово перепроверки — новым разговором', () => {
  it('связь нового ключа — копия прежней с новым разговором; старт без resume, вводная + слово', () => {
    const h = harness();
    expect(h.send(record(), group(), 'Перепроверь MR')).toBe('sent');
    const key = `new-${NOW}-recheck1`;
    expect(h.links[key]).toMatchObject({
      conversation: key,
      createdAt: new Date(NOW).toISOString(),
      parentChatId: 'parent',
      stage: 'build',
      model: 'opus',
    });
    expect(h.links['old-session']?.conversation).toBe('old-session');
    expect(h.starts).toHaveLength(1);
    const start = h.starts[0]!;
    expect(start).toMatchObject({
      chatId: key,
      cwd: 'C:/wt/front',
      model: 'opus',
      effort: 'high',
      stage: 'tell',
      fromAliases: ['old-session'],
      title: 'Фронт',
    });
    expect(start).not.toHaveProperty('resume');
    expect(start.prompt.startsWith('This is a NEW conversation')).toBe(true);
    expect(start.prompt.endsWith('\n\nПерепроверь MR')).toBe(true);
    expect(start.prompt).toContain('- PROJ-1 кнопка');
    expect(h.resumed).toEqual([]);
  });

  it('нет связи или копии — прежний путь', () => {
    const noLink = harness({ links: {} });
    expect(noLink.send(record(), group(), 'w')).toBe('sent');
    expect(noLink.resumed).toEqual(['w']);
    const noPath = harness();
    noPath.send(record(), group({ path: undefined }), 'w');
    expect(noPath.resumed).toEqual(['w']);
    expect(noPath.starts).toEqual([]);
  });

  it('только временные ключи new- — настоящей сессии нет, прежний путь', () => {
    const h = harness({ links: { 'new-1-x': link({ conversation: 'new-1-x' }) } });
    h.send(record(), group({ chatId: 'new-1-x' }), 'w');
    expect(h.resumed).toEqual(['w']);
    expect(h.starts).toEqual([]);
  });

  it('чужой CLI среди ключей разговора — прежний путь', () => {
    const h = harness({
      links: {
        'old-session': link(),
        'codex:abc': link(),
      },
    });
    h.send(record(), group(), 'w');
    expect(h.resumed).toEqual(['w']);
    expect(Object.keys(h.links).some((key) => key.startsWith('new-'))).toBe(false);
  });

  it('у группы идёт ход — второго агента в копии не заводим', () => {
    const h = harness({ running: ['old-session'] });
    h.send(record(), group(), 'w');
    expect(h.resumed).toEqual(['w']);
    expect(h.starts).toEqual([]);
  });

  it('старт отказал — новая связь снята, слово прежним путём', () => {
    const h = harness({ start: () => ({ started: false, busy: true }) });
    expect(h.send(record(), group(), 'w')).toBe('sent');
    expect(h.removed).toEqual([`new-${NOW}-recheck1`]);
    expect(h.links[`new-${NOW}-recheck1`]).toBeUndefined();
    expect(h.resumed).toEqual(['w']);
    expect(h.logs.some((line) => line.includes('refused'))).toBe(true);
  });

  it('старт бросил — то же: связь снята, ошибка в журнале, прежний путь', () => {
    const h = harness({
      start: () => {
        throw new Error('spawn ENOENT');
      },
    });
    h.send(record(), group(), 'w');
    expect(h.removed).toEqual([`new-${NOW}-recheck1`]);
    expect(h.resumed).toEqual(['w']);
    expect(h.logs).toContain('mr recheck: fresh session start failed');
  });
});
