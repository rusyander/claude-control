import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSummary } from '@agentdeck/contracts';
import type { Record } from '../ChatRecords/ChatRecords.ts';
import {
  buildInbox,
  createTranscriptTailReader,
  liveByTail,
  OUTSIDE_LIVE_MS,
  turnOpenIn,
  type InboxSources,
} from './chat-inbox.ts';

/**
 * Ход вне панели (терминал, VS Code): в реестре его нет, и телефон говорил
 * «молчит», пока агент на компьютере шёл по шагам. Правда о нём — только хвост
 * транскрипта: последняя запись разговора и время файла.
 */

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const user = (content: unknown, over: Partial<Record> = {}): Record => ({
  type: 'user',
  message: { role: 'user', content: content as string },
  ...over,
});
const assistant = (stop: string | null, over: Partial<Record> = {}): Record => ({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: '…' }] },
  ...over,
});
const toolResult = user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);

describe('turnOpenIn — открыт ли ход по записям', () => {
  it('ход кончился ответом модели — закрыт', () => {
    expect(
      turnOpenIn([user('сделай'), assistant('tool_use'), toolResult, assistant('end_turn')]),
    ).toBe(false);
  });

  it('модель вызвала инструмент — открыт, пока результата нет и после него', () => {
    expect(turnOpenIn([user('сделай'), assistant('tool_use')])).toBe(true);
    expect(turnOpenIn([user('сделай'), assistant('tool_use'), toolResult])).toBe(true);
  });

  it('новая реплика человека после конца хода — открыт', () => {
    expect(turnOpenIn([assistant('end_turn'), user('ещё')])).toBe(true);
  });

  it('отмена человеком (Esc) — закрыт, строкой и блоком', () => {
    expect(turnOpenIn([assistant('tool_use'), user('[Request interrupted by user]')])).toBe(false);
    expect(
      turnOpenIn([
        assistant('tool_use'),
        user([
          { type: 'tool_result', tool_use_id: 't1', content: 'x' },
          { type: 'text', text: '[Request interrupted by user for tool use]' },
        ]),
      ]),
    ).toBe(false);
  });

  it('служебное, субагенты и ошибки API хода не меняют', () => {
    const tail = [
      assistant('end_turn'),
      user('<command>', { isMeta: true }),
      assistant('tool_use', { isSidechain: true }),
      assistant(null, { isApiErrorMessage: true }),
      { type: 'system' } as Record,
    ];
    expect(turnOpenIn(tail)).toBe(false);
  });

  it('пустой хвост — закрыт', () => {
    expect(turnOpenIn([])).toBe(false);
  });
});

describe('liveByTail — граница молчания', () => {
  const tail = (turnOpen: boolean, silentMs: number) => ({
    asked: undefined,
    turnOpen,
    mtimeMs: NOW - silentMs,
  });

  it('открытый ход живёт ровно до границы, на миллисекунду дальше — нет', () => {
    expect(liveByTail(tail(true, OUTSIDE_LIVE_MS), NOW)).toBe(true);
    expect(liveByTail(tail(true, OUTSIDE_LIVE_MS + 1), NOW)).toBe(false);
  });

  it('закрытый ход не живой даже со свежим файлом; нет файла — нет хода', () => {
    expect(liveByTail(tail(false, 0), NOW)).toBe(false);
    expect(liveByTail(undefined, NOW)).toBe(false);
  });
});

describe('buildInbox — ход вне панели', () => {
  const chat = (id: string): ChatSummary => ({
    id,
    title: id,
    project: 'shop',
    projectPath: 'C:/work/shop',
    isSandbox: false,
    messageCount: 3,
    createdAt: iso(60),
    updatedAt: iso(1),
  });
  const sources = (over: Partial<InboxSources>): InboxSources => ({
    chats: [chat('vscode'), chat('quiet')],
    runs: [],
    permissions: [],
    lastAsked: () => undefined,
    now: NOW,
    ...over,
  });

  it('чат, идущий в VS Code, — «работает» с меткой вне панели, молчащий — нет', () => {
    const inbox = buildInbox(sources({ liveOutside: (id) => id === 'vscode' }));
    const byId = new Map(inbox.chats.map((row) => [row.id, row]));
    expect(byId.get('vscode')).toMatchObject({ status: 'running', running: true, outside: true });
    expect(byId.get('quiet')).toMatchObject({ status: 'idle', running: false });
    expect(byId.get('quiet')?.outside).toBeUndefined();
    expect(inbox.chats[0]?.id).toBe('vscode');
  });

  it('свой прогон панели меткой вне панели не помечается', () => {
    const inbox = buildInbox(
      sources({
        runs: [{ key: 'vscode', sessionId: 'vscode', startedAt: NOW - 1000 }],
        liveOutside: () => true,
      }),
    );
    const row = inbox.chats.find((item) => item.id === 'vscode');
    expect(row).toMatchObject({ running: true, runKey: 'vscode' });
    expect(row?.outside).toBeUndefined();
  });

  it('вопрос посреди хода вне панели — «ждёт вас», ход остаётся помеченным', () => {
    const inbox = buildInbox(
      sources({
        liveOutside: (id) => id === 'vscode',
        lastAsked: (id) =>
          id === 'vscode'
            ? {
                toolUseId: 'q1',
                input: { questions: [{ question: 'Какую?', options: [{ label: 'A' }] }] },
                askedAt: iso(0),
              }
            : undefined,
      }),
    );
    expect(inbox.chats.find((item) => item.id === 'vscode')).toMatchObject({
      status: 'waiting',
      outside: true,
    });
  });

  it('запрос прав, который держит хук панели, — строка «ждёт вас» в чате своей сессии', () => {
    const inbox = buildInbox(
      sources({
        liveOutside: (id) => id === 'vscode',
        outsidePermissions: [
          {
            toolUseId: 'b1',
            sessionId: 'vscode',
            toolName: 'Bash',
            input: { command: 'rm -rf dist' },
            askedAt: iso(0),
          },
          // Сессия без транскрипта в сводке — строке некуда встать, она не выдумывается.
          { toolUseId: 'b2', sessionId: 'ghost', toolName: 'Bash', askedAt: iso(0) },
        ],
      }),
    );
    const row = inbox.chats.find((item) => item.id === 'vscode');
    expect(row).toMatchObject({ status: 'waiting', outside: true });
    expect(row?.asks).toEqual([
      {
        kind: 'permission',
        key: 'r:b1',
        toolUseId: 'b1',
        toolName: 'Bash',
        input: { command: 'rm -rf dist' },
        askedAt: iso(0),
        relay: true,
      },
    ]);
    expect(inbox.chats.some((item) => item.id === 'ghost')).toBe(false);
    expect(inbox.chats[0]?.id).toBe('vscode');
  });
});

describe('createTranscriptTailReader — настоящий файл', () => {
  it('видит открытый ход и время файла, перечитывает по смене файла', () => {
    const root = mkdtempSync(join(tmpdir(), 'inbox-outside-'));
    try {
      const dir = join(root, 'C--work-shop');
      mkdirSync(dir);
      const file = join(dir, 'sess.jsonl');
      const lines = (records: Record[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
      writeFileSync(file, lines([user('сделай'), assistant('tool_use')]));
      const read = createTranscriptTailReader(() => root);

      const open = read('sess');
      expect(open?.turnOpen).toBe(true);
      expect(liveByTail(open, Date.now())).toBe(true);

      writeFileSync(
        file,
        lines([user('сделай'), assistant('tool_use'), toolResult, assistant('end_turn')]),
      );
      // Размер сменился — хвост перечитан, ход закрыт.
      expect(read('sess')?.turnOpen).toBe(false);

      // Открытый ход, но файл молчит дольше границы — процесс считается мёртвым.
      writeFileSync(file, lines([user('сделай'), assistant('tool_use'), toolResult]));
      const old = (Date.now() - OUTSIDE_LIVE_MS - 60_000) / 1000;
      utimesSync(file, old, old);
      const stale = read('sess');
      expect(stale?.turnOpen).toBe(true);
      expect(liveByTail(stale, Date.now())).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
