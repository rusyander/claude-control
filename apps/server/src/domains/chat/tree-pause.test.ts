import { describe, it, expect } from 'vitest';
import { buildTreeResumePrompt } from '@agentdeck/contracts/chat-handoff';
import type { ChatLink, TreePauseRecord } from '../../lib/app-store/app-store.types.ts';
import type { RunMeta, RunSnapshot } from './ChatRunRegistry.ts';
import type { RunOptions } from './ChatRunner.ts';
import type { AutoApproveState } from './ChatSession.ts';
import {
  collectTree,
  pausedChatIds,
  rootOf,
  TreePause,
  type TreePauseStore,
} from './tree-pause.ts';

const link = (parentChatId: string, extra: Partial<ChatLink> = {}): ChatLink => ({
  parentChatId,
  createdAt: '2026-09-09T10:00:00.000Z',
  ...extra,
});

/** Дерево: корень `root` (ключ сессии), два ребёнка, у первого — звено ревью и продолжение. */
const LINKS: Record<string, ChatLink> = {
  'new-a': link('root', { title: 'Форма', branch: 'f/form' }),
  'sess-a': link('root', { title: 'Форма', branch: 'f/form' }),
  'new-b': link('root', { title: 'Сборка', branch: 'f/build' }),
  'new-a-review': link('sess-a', { title: 'Форма', branch: 'f/form', stage: 'review' }),
  'new-a-cont': link('new-a-review', { title: 'Форма', branch: 'f/form', stage: 'review' }),
  stranger: link('other-root', { title: 'Чужой' }),
};

/** Реестр в памяти: что идёт, что остановлено, с чем запущено. */
function fakeRuns(running: Record<string, { sessionId?: string; options?: Partial<RunOptions> }>) {
  const runs = new Map<string, RunSnapshot>();
  for (const [key, run] of Object.entries(running)) {
    runs.set(key, {
      key,
      status: 'running',
      options: { prompt: `задание ${key}`, cwd: 'C:/p', model: 'sonnet', ...run.options },
      meta: { projectPath: 'C:/p' },
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    });
  }
  const stopped: string[] = [];
  const started: { chatId: string; options: RunOptions; meta: RunMeta }[] = [];
  return {
    stopped,
    started,
    describe: (chatId: string) => runs.get(chatId),
    isRunning: (chatId: string) => runs.get(chatId)?.status === 'running',
    stop: (chatId: string) => {
      if (!runs.has(chatId)) return false;
      runs.delete(chatId);
      stopped.push(chatId);
      return true;
    },
    start: (chatId: string, options: RunOptions, meta: RunMeta) => {
      if (runs.get(chatId)?.status === 'running') return false;
      runs.set(chatId, { key: chatId, status: 'running', options, meta });
      started.push({ chatId, options, meta });
      return true;
    },
  };
}

function memoryStore(): TreePauseStore & { records: Record<string, TreePauseRecord> } {
  const records: Record<string, TreePauseRecord> = {};
  return {
    records,
    get: (root) => records[root],
    all: () => records,
    set: (record) => {
      records[record.root] = record;
    },
    clear: (root) => {
      delete records[root];
    },
  };
}

describe('дерево разговоров', () => {
  it('корень — подъём по связям до разговора без связи, по любому ключу', () => {
    expect(rootOf(LINKS, 'new-a-cont')).toBe('root');
    expect(rootOf(LINKS, 'sess-a')).toBe('root');
    expect(rootOf(LINKS, 'root')).toBe('root');
    expect(rootOf(LINKS, 'никому-не-известный')).toBe('никому-не-известный');
  });

  it('зациклившиеся связи подъём не вешают', () => {
    const loop: Record<string, ChatLink> = { a: link('b'), b: link('a') };
    expect(rootOf(loop, 'a')).toBe('b');
  });

  it('обход собирает всех потомков по ключам, чужое дерево не трогает', () => {
    expect(collectTree(LINKS, 'root').sort()).toEqual(
      ['new-a', 'sess-a', 'new-b', 'new-a-review', 'new-a-cont'].sort(),
    );
    expect(collectTree(LINKS, 'other-root')).toEqual(['stranger']);
  });

  it('ключи стоящих деревьев: корень, потомки, остановленные прогоны и их сессии, очередь', () => {
    const records: Record<string, TreePauseRecord> = {
      root: {
        root: 'root',
        at: '2026-09-09T10:00:00.000Z',
        chats: {
          'new-b': { cwd: 'C:/p', sessionId: 'sess-b', options: {}, meta: {}, pausedAt: '' },
        },
        pendingStarts: [{ kind: 'stage', chatId: 'new-b-review', options: {}, meta: {}, at: '' }],
      },
    };
    const ids = pausedChatIds(records, LINKS);
    for (const id of ['root', 'sess-a', 'new-a-cont', 'sess-b', 'new-b-review']) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(ids.has('stranger')).toBe(false);
  });
});

describe('пауза дерева', () => {
  it('останавливает идущие прогоны дерева — и только его, со снимком сессии и прав', () => {
    const runs = fakeRuns({
      root: { sessionId: 'root' },
      'new-a': { sessionId: 'sess-a' },
      'new-a-review': {},
      stranger: { sessionId: 'sess-stranger' },
    });
    const store = memoryStore();
    const armed: Record<string, AutoApproveState> = {};
    const tree = new TreePause({
      links: () => LINKS,
      runs,
      store,
      autoApprove: {
        snapshot: (chatId) =>
          chatId === 'new-a' ? { enabled: true, allowEdits: true } : undefined,
        arm: (chatId, state) => {
          armed[chatId] = state;
        },
      },
      now: () => new Date('2026-09-09T12:00:00.000Z'),
    });

    const result = tree.pause('sess-a');
    expect(result).toEqual({ root: 'root', stopped: 3, chats: 3, alreadyPaused: false });
    expect(runs.stopped.sort()).toEqual(['new-a', 'new-a-review', 'root']);
    expect(runs.isRunning('stranger')).toBe(true);

    const record = store.records.root as TreePauseRecord;
    expect(record.at).toBe('2026-09-09T12:00:00.000Z');
    expect(record.chats['new-a']?.sessionId).toBe('sess-a');
    expect(record.chats['new-a']?.autoApprove).toEqual({ enabled: true, allowEdits: true });
    expect(record.chats['new-a-review']?.sessionId).toBeUndefined();
    expect(tree.isPaused('new-a-cont')).toBe(true);
    expect(tree.isPaused('stranger')).toBe(false);

    // Повтор — доостанавливает успевшее запуститься, запись та же.
    runs.start('new-b', { prompt: 'вручную', cwd: 'C:/p' }, { projectPath: 'C:/p' });
    const again = tree.pause('root');
    expect(again).toEqual({ root: 'root', stopped: 1, chats: 4, alreadyPaused: true });
    expect(store.records.root?.at).toBe('2026-09-09T12:00:00.000Z');
  });

  it('стоящее дерево откладывает автостарты в очередь, свободное — пропускает', () => {
    const runs = fakeRuns({});
    const store = memoryStore();
    const tree = new TreePause({ links: () => LINKS, runs, store });
    const options: RunOptions = { prompt: 'ревью', cwd: 'C:/p' };

    expect(tree.defer('stage', 'new-a-review', options, { projectPath: 'C:/p' })).toBe(false);
    tree.pause('root');
    expect(tree.defer('stage', 'new-a-review', options, { projectPath: 'C:/p' })).toBe(true);
    expect(tree.defer('split', 'stranger', options, {})).toBe(false);
    expect(store.records.root?.pendingStarts.map((p) => p.chatId)).toEqual(['new-a-review']);
    expect(tree.view('root').paused).toEqual({
      at: expect.any(String),
      chats: 0,
      pending: 1,
    });
  });

  it('продолжение: остановленное — в тех же сессиях, очередь — по порядку, запись снята', () => {
    const runs = fakeRuns({
      'new-a': { sessionId: 'sess-a', options: { fork: true, model: 'opus' } },
      'new-a-review': {},
    });
    const store = memoryStore();
    const armed: Record<string, AutoApproveState> = {};
    const tree = new TreePause({
      links: () => LINKS,
      runs,
      store,
      autoApprove: {
        snapshot: () => ({ enabled: true, allowEdits: false }),
        arm: (chatId, state) => {
          armed[chatId] = state;
        },
      },
    });
    tree.pause('root');
    tree.defer('handoff', 'new-a-cont', { prompt: 'дальше', cwd: 'C:/p' }, { projectPath: 'C:/p' });
    tree.defer('split', 'new-b', { prompt: 'сборка', cwd: 'C:/p' }, { projectPath: 'C:/p' });

    const result = tree.resume('new-a');
    expect(result).toEqual({ root: 'root', wasPaused: true, resumed: 2, flushed: 2 });
    expect(store.records.root).toBeUndefined();

    const byId = Object.fromEntries(runs.started.map((s) => [s.chatId, s]));
    // Сессия известна — та же сессия, одна фраза о паузе, модель прежняя, fork снят.
    expect(byId['new-a']?.options.sessionId).toBe('sess-a');
    expect(byId['new-a']?.options.prompt).toBe(buildTreeResumePrompt());
    expect(byId['new-a']?.options.model).toBe('opus');
    expect(byId['new-a']?.options.fork).toBeUndefined();
    expect(byId['new-a']?.meta.sessionId).toBe('sess-a');
    expect(armed['new-a']).toEqual({ enabled: true, allowEdits: false });
    // Сессии не было — задание идёт заново, как было.
    expect(byId['new-a-review']?.options.sessionId).toBeUndefined();
    expect(byId['new-a-review']?.options.prompt).toBe('задание new-a-review');
    // Очередь — после остановленных и в порядке поступления.
    expect(runs.started.slice(2).map((s) => s.chatId)).toEqual(['new-a-cont', 'new-b']);

    expect(tree.resume('root')).toEqual({ root: 'root', wasPaused: false, resumed: 0, flushed: 0 });
  });

  it('вид дерева: два ключа одного разговора — один узел под ключом сессии', () => {
    const runs = fakeRuns({ 'new-a-review': {}, root: {} });
    const tree = new TreePause({ links: () => LINKS, runs, store: memoryStore() });
    const view = tree.view('new-b');
    expect(view.root).toBe('root');
    expect(view.paused).toBeUndefined();
    const form = view.nodes.find((node) => node.chatId === 'sess-a');
    expect(form?.aliases).toEqual(['new-a']);
    expect(form?.title).toBe('Форма');
    expect(view.nodes.some((node) => node.chatId === 'new-a')).toBe(false);
    expect(view.nodes.find((node) => node.chatId === 'new-a-review')?.running).toBe(true);
    expect(view.nodes.find((node) => node.chatId === 'new-a-review')?.stage).toBe('review');
    // Идущих: звено ревью и сам корень.
    expect(view.running).toBe(2);
    expect(view.nodes.some((node) => node.chatId === 'stranger')).toBe(false);
  });
});
