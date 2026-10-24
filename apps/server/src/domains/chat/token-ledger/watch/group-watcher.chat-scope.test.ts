import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_SCOPE_INDEX,
  GROUP_WATCH_DEFAULTS,
  groupSignalsOf,
  type GroupSignal,
  type GroupWatch,
  type GroupWatchRecord,
} from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import { GroupWatcher, type WatchTarget } from './group-watcher.ts';

/**
 * Одиночный чат панели (A1): разговор без связи с деревом под тем же сторожем, что
 * звенья групп. Переписка — НАСТОЯЩИЕ вырезки (`__fixtures__/leak/R24-…`, `R25-…`),
 * дочитанные хвостом транскрипта у прогона, подхваченного без потока: строка →
 * читатель → свёртка → правила `SINGLE_RULES` → срез сигналов чата. Подменены
 * только ответы проводки (кто чат, что знает панель).
 */

const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/leak/${name}`, import.meta.url), 'utf8');
const lastStamp = (text: string): number =>
  Math.max(...[...text.matchAll(/"timestamp":"([^"]+)"/g)].map((match) => Date.parse(match[1]!)));

function setup(options: { settings?: Partial<GroupWatch>; fixture: string }) {
  const text = fixture(options.fixture);
  let now = lastStamp(text) - MIN;
  const settings: GroupWatch = { ...GROUP_WATCH_DEFAULTS, ...options.settings };
  const dir = mkdtempSync(join(tmpdir(), 'gw-chat-scope-'));
  dirs.push(dir);
  const file = join(dir, 's-chat.jsonl');
  writeFileSync(file, '');
  const chats = new Map<string, GroupWatchRecord>();
  const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
  const saved: string[] = [];
  const notified: Array<{ signal: GroupSignal; target: WatchTarget }> = [];
  const watcher = new GroupWatcher({
    settings: () => settings,
    // Как проводка: звено — по связи; без связи, при включённых одиночных чатах — чат.
    resolve: (chatId) => {
      if (chatId === 'child-1') return { chatId, parentChatId: 'parent', groupIndex: 1 };
      if (!settings.singleChats || chatId.startsWith('status-')) return undefined;
      return { scope: 'chat', chatId, parentChatId: chatId, groupIndex: CHAT_SCOPE_INDEX };
    },
    group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
    save: (parent) => saved.push(`group:${parent}`),
    chatSignals: {
      get: (chatId) => chats.get(chatId),
      set: (chatId, record) => (record ? chats.set(chatId, record) : chats.delete(chatId)),
      all: () => Object.fromEntries(chats),
    },
    saveChat: (chatId) => saved.push(`chat:${chatId}`),
    node: () => ({ running: true, paused: false }),
    transcript: (id) => (id === 's-chat' ? file : undefined),
    notify: (signal, target) => notified.push({ signal, target }),
    now: () => now,
    makeId: () => `id-${notified.length}-${chats.size}`,
    plans: () => ({ parent: { groups: [group] } }),
  });
  /** Подхват без потока, затем строки вырезки дописываются в транскрипт и читаются на тике. */
  const adoptAndRead = (chatId: string) => {
    watcher.onFeed(chatId, {
      kind: 'start',
      sessionId: 's-chat',
      cwd: '/work/app',
      detached: true,
    });
    appendFileSync(file, text);
    now = lastStamp(text) + MIN;
    watcher.tick();
  };
  const signals = (chatId: string) => groupSignalsOf(chats.get(chatId));
  return { watcher, group, chats, saved, notified, adoptAndRead, signals };
}

describe('GroupWatcher одиночный чат панели (A1)', () => {
  it('чат без связи: два одинаковых таймаута клика Playwright из настоящей переписки — R24 в срезе чата, не на группе', () => {
    const w = setup({ fixture: 'R24-repeat-error/fire.jsonl', settings: { errorRepeats: 2 } });
    w.adoptAndRead('chat-1');
    expect(w.signals('chat-1')).toMatchObject([
      {
        rule: 'R24',
        severity: 'warn',
        groupIndex: CHAT_SCOPE_INDEX,
        chatId: 'chat-1',
        numbers: { fails: 2 },
        params: { call: 'mcp__playwright__browser_click' },
      },
    ]);
    expect(w.signals('chat-1')[0]?.stage).toBeUndefined();
    expect(w.group.watch).toBeUndefined();
    expect(w.saved).toContain('chat:chat-1');
    expect(w.saved.some((entry) => entry.startsWith('group:'))).toBe(false);
    // «Внимание» одиночного чата наружу не идёт: Telegram — только тревога (решение владельца 1).
    expect(w.notified).toEqual([]);
  });

  it('заводской порог 3 на той же переписке — тишина (порог читается)', () => {
    const w = setup({ fixture: 'R24-repeat-error/fire.jsonl' });
    w.adoptAndRead('chat-1');
    expect(w.signals('chat-1')).toEqual([]);
  });

  it('`singleChats` выключен — чат без связи не под наблюдением, как до A1', () => {
    const w = setup({
      fixture: 'R24-repeat-error/fire.jsonl',
      settings: { errorRepeats: 2, singleChats: false },
    });
    w.adoptAndRead('chat-1');
    expect(w.chats.size).toBe(0);
    expect(w.watcher.watched).toBe(0);
  });

  it('служебный чат панели (проводка его не узнаёт целью) — ничего', () => {
    const w = setup({ fixture: 'R24-repeat-error/fire.jsonl', settings: { errorRepeats: 2 } });
    w.adoptAndRead('status-1');
    expect(w.chats.size).toBe(0);
  });

  it('тревога одиночного чата (R25 обход отбитого rebase) уходит наружу один раз, с целью чата без стадии', () => {
    const w = setup({ fixture: 'R25-denied-bypass/fire.jsonl' });
    w.adoptAndRead('chat-2');
    expect(w.signals('chat-2').map((signal) => signal.rule)).toContain('R25');
    expect(w.notified.map(({ signal }) => signal.rule)).toEqual(['R25']);
    expect(w.notified[0]?.target).toMatchObject({
      scope: 'chat',
      chatId: 'chat-2',
      parentChatId: 'chat-2',
      cwd: '/work/app',
    });
    expect(w.notified[0]?.target.stage).toBeUndefined();
  });

  it('выключили `singleChats` на ходу — сессия чата забыта, её сигналы закрыты на ближайшем тике', () => {
    const settings: Partial<GroupWatch> = { errorRepeats: 2 };
    const w = setup({ fixture: 'R24-repeat-error/fire.jsonl', settings });
    w.adoptAndRead('chat-1');
    expect(w.signals('chat-1').filter((signal) => !signal.clearedAt)).toHaveLength(1);
    const live = w.watcher as unknown as { deps: { settings: () => GroupWatch } };
    const before = live.deps.settings();
    live.deps.settings = () => ({ ...before, singleChats: false });
    w.watcher.tick();
    expect(w.watcher.watched).toBe(0);
    expect(w.signals('chat-1').every((signal) => signal.clearedAt)).toBe(true);
  });
});

describe('GroupWatcher одиночный чат: временный ключ', () => {
  it('первый ход под `new-…`: сигналы переезжают на настоящий ключ чата вместе с блоком', () => {
    const text = fixture('R24-repeat-error/fire.jsonl');
    let now = lastStamp(text) - MIN;
    const dir = mkdtempSync(join(tmpdir(), 'gw-chat-rekey-'));
    dirs.push(dir);
    const file = join(dir, 's-chat.jsonl');
    writeFileSync(file, '');
    const chats = new Map<string, GroupWatchRecord>();
    let born = false;
    const watcher = new GroupWatcher({
      settings: () => ({ ...GROUP_WATCH_DEFAULTS, errorRepeats: 2 }),
      resolve: (chatId) => ({
        scope: 'chat',
        chatId,
        parentChatId: chatId,
        groupIndex: CHAT_SCOPE_INDEX,
      }),
      group: () => undefined,
      save: () => {},
      chatSignals: {
        get: (chatId) => chats.get(chatId),
        set: (chatId, record) => (record ? chats.set(chatId, record) : chats.delete(chatId)),
        all: () => Object.fromEntries(chats),
      },
      node: () => ({ running: true, paused: false }),
      transcript: (id) => (id === 's-chat' ? file : undefined),
      canonical: (chatId) => (born && chatId === 'new-1' ? 's-chat' : chatId),
      now: () => now,
      makeId: () => 'id',
    });
    watcher.onFeed('new-1', {
      kind: 'start',
      sessionId: 's-chat',
      cwd: '/work/app',
      detached: true,
    });
    appendFileSync(file, text);
    now = lastStamp(text) + MIN;
    watcher.tick();
    expect(groupSignalsOf(chats.get('new-1')).map((signal) => signal.rule)).toEqual(['R24']);
    born = true;
    watcher.tick();
    expect(chats.has('new-1')).toBe(false);
    expect(groupSignalsOf(chats.get('s-chat'))).toMatchObject([{ rule: 'R24', chatId: 's-chat' }]);
  });
});
