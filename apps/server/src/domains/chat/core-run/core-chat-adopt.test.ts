import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { adoptTakeoverChat, coreChatProjectOf } from './core-chat-adopt.ts';
import {
  coreChatBookPath,
  coreChatCliOf,
  coreChatOfTask,
  createCoreChatBook,
} from './core-chat-book.ts';

/**
 * Усыновление чата перехвата (этап 12, B5): «Открыть чат» перехваченной задачи ведёт в разговор,
 * которого панель не начинала, — книга получает запись того же вида, что пишет прогон панели.
 */
const SOURCE = '01a1bb30-0000-7000-8000-000000000001';
const CHAT = '01a1bb30-0000-7000-8000-000000000002';
const UNIT = '01a1bb30-0000-7000-8000-000000000003';
const STEP = '01a1bb30-0000-7000-8000-000000000004';
const FIRST = '01a1bb30-0000-7000-8000-000000000005';
const LATER = '01a1bb30-0000-7000-8000-000000000006';
const COPY = 'C:/copies/unit-1';

/** Вид задачи — только поля, которые читает усыновление. */
function view(fields: Partial<TaskView>): TaskView {
  return { steps: [], sessions: [], ...fields } as TaskView;
}

const chatView = (over: Partial<TaskView> = {}): TaskView =>
  view({
    taskId: CHAT,
    takeoverOf: { taskId: SOURCE, unitId: UNIT },
    steps: [{ stepId: STEP, stepKind: 'chat', startedSeq: 3 } as TaskView['steps'][number]],
    sessions: [
      { sessionId: LATER, stepId: STEP, cli: 'claude', startedSeq: 9 },
      { sessionId: FIRST, stepId: STEP, cli: 'claude', startedSeq: 4 },
    ] as TaskView['sessions'],
    ...over,
  });

const sourceView = (chatTaskId: string | undefined = CHAT): TaskView =>
  view({
    taskId: SOURCE,
    takeover: { unitId: UNIT, copy: COPY, seq: 7, ...(chatTaskId ? { chatTaskId } : {}) },
  });

function portOf(views: Record<string, TaskView | null>) {
  const asked: string[] = [];
  return {
    asked,
    port: {
      async view(taskId: string) {
        asked.push(taskId);
        return views[taskId] ?? null;
      },
    },
  };
}

describe('adoptTakeoverChat — the core-opened takeover chat joins the chat book', () => {
  const dirs: string[] = [];
  const fresh = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'core-chat-adopt-'));
    dirs.push(dir);
    return coreChatBookPath(dir);
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('names the first session of the chat step and books it with its CLI and the unit copy', async () => {
    const file = fresh();
    const { port } = portOf({ [CHAT]: chatView(), [SOURCE]: sourceView() });
    expect(await adoptTakeoverChat(port, file, CHAT)).toBe(FIRST);
    expect(coreChatOfTask(file, CHAT)).toBe(FIRST);
    expect(createCoreChatBook(file).get(FIRST)).toEqual({ taskId: CHAT, stepId: STEP });
    expect(coreChatCliOf(file, FIRST)).toBe('claude');
  });

  it('a task the book already knows is answered from the book, the core is not asked', async () => {
    const file = fresh();
    createCoreChatBook(file).set('known-conv', { taskId: CHAT, stepId: STEP });
    const { port, asked } = portOf({});
    expect(await adoptTakeoverChat(port, file, CHAT)).toBe('known-conv');
    expect(asked).toEqual([]);
  });

  it('refuses a task that is not a takeover chat, a closed takeover and a takeover of another chat', async () => {
    const file = fresh();
    const plain = portOf({ [CHAT]: chatView({ takeoverOf: undefined }), [SOURCE]: sourceView() });
    expect(await adoptTakeoverChat(plain.port, file, CHAT)).toBeUndefined();
    const closed = portOf({ [CHAT]: chatView(), [SOURCE]: view({ takeover: null }) });
    expect(await adoptTakeoverChat(closed.port, file, CHAT)).toBeUndefined();
    const other = portOf({ [CHAT]: chatView(), [SOURCE]: sourceView(LATER) });
    expect(await adoptTakeoverChat(other.port, file, CHAT)).toBeUndefined();
    expect(coreChatOfTask(file, CHAT)).toBeUndefined();
  });

  it('a chat with no session yet, or a core that does not answer, books nothing', async () => {
    const file = fresh();
    const early = portOf({ [CHAT]: chatView({ sessions: [] }), [SOURCE]: sourceView() });
    expect(await adoptTakeoverChat(early.port, file, CHAT)).toBeUndefined();
    const down = {
      async view(): Promise<TaskView | null> {
        throw new Error('core down');
      },
    };
    expect(await adoptTakeoverChat(down, file, CHAT)).toBeUndefined();
    expect(coreChatOfTask(file, CHAT)).toBeUndefined();
  });
});

describe('coreChatProjectOf — the tab whose list shows a book conversation', () => {
  const git = (cwd: string, ...args: string[]): void => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };

  it('a takeover chat in a git copy of the unit names the main checkout; a plain folder names itself; unknown or folderless — none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-chat-project-'));
    try {
      const main = join(dir, 'repo');
      const copy = join(dir, 'repo-worktrees', 'unit-1');
      mkdirSync(main);
      git(main, 'init', '-q', '-b', 'main');
      git(
        main,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      );
      git(main, 'worktree', 'add', '-q', '-b', 'unit-1', copy);
      const file = coreChatBookPath(dir);
      const book = createCoreChatBook(file);
      book.set('in-copy', { taskId: CHAT, stepId: STEP, cli: 'claude', cwd: copy });
      book.set('in-folder', { taskId: SOURCE, stepId: STEP, cli: 'qwen', cwd: join(dir, 'plain') });
      book.set('no-folder', { taskId: UNIT, stepId: STEP, cli: 'qwen' });
      // `native`: каталог temp на Windows приходит коротким именем (8.3), git пишет длинное.
      const real = (p: string): string => realpathSync.native(p);
      expect(real(coreChatProjectOf(file, 'in-copy')!)).toBe(real(main));
      expect(coreChatProjectOf(file, 'in-folder')).toBe(join(dir, 'plain'));
      expect(coreChatProjectOf(file, 'no-folder')).toBeUndefined();
      expect(coreChatProjectOf(file, 'never-booked')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('core chat book — every write reads the file afresh', () => {
  it('a book opened earlier keeps an entry another writer added after it opened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-chat-book-rmw-'));
    try {
      const file = coreChatBookPath(dir);
      const panel = createCoreChatBook(file);
      panel.set('panel-conv', { taskId: SOURCE, stepId: STEP });
      // Другой писатель (усыновление) дописывает файл мимо экземпляра панели.
      createCoreChatBook(file).set('adopted-conv', { taskId: CHAT, stepId: STEP, cli: 'claude' });
      expect(panel.get('adopted-conv')).toEqual({ taskId: CHAT, stepId: STEP });
      panel.set('later-conv', { taskId: UNIT, stepId: STEP });
      panel.forget('panel-conv');
      expect(coreChatOfTask(file, CHAT)).toBe('adopted-conv');
      expect(coreChatOfTask(file, UNIT)).toBe('later-conv');
      writeFileSync(file, 'not json');
      expect(panel.get('adopted-conv')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
