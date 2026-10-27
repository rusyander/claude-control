import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@agentdeck/contracts';
import type { Record } from '../ChatRecords/ChatRecords.ts';
import { buildInbox, clientIn } from './chat-inbox.ts';

/**
 * Чья сессия: панель (`claude -p`), VS Code или терминал. Это пишет сам CLI —
 * поле `entrypoint` в каждой записи транскрипта. Последняя запись главнее:
 * сессию VS Code, которую панель однажды продолжила, ведёт снова VS Code, как
 * только там написали (живая сессия e6600235, 25.10: `claude-vscode`, затем
 * `sdk-cli`, затем снова `claude-vscode`).
 */

const record = (entrypoint: string | undefined, over: Partial<Record> = {}): Record =>
  ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '…' }] },
    ...(entrypoint ? { entrypoint } : {}),
    ...over,
  }) as Record;

describe('clientIn — кто ведёт сессию по транскрипту', () => {
  it('панель, VS Code, терминал и прочие клиенты', () => {
    expect(clientIn([record('sdk-cli')])).toBe('panel');
    expect(clientIn([record('claude-vscode')])).toBe('vscode');
    expect(clientIn([record('cli')])).toBe('terminal');
    expect(clientIn([record('claude-desktop')])).toBe('other');
  });

  it('последняя запись главнее: VS Code после хода панели — снова VS Code', () => {
    expect(clientIn([record('claude-vscode'), record('sdk-cli'), record('claude-vscode')])).toBe(
      'vscode',
    );
    expect(clientIn([record('claude-vscode'), record('sdk-cli')])).toBe('panel');
  });

  it('записи без поля и субагенты не голосуют; поля нет нигде — неизвестно', () => {
    expect(clientIn([record('claude-vscode'), record(undefined)])).toBe('vscode');
    expect(clientIn([record('cli'), record('sdk-cli', { isSidechain: true })])).toBe('terminal');
    expect(clientIn([record(undefined)])).toBeUndefined();
  });
});

describe('buildInbox — клиент сессии в сводке', () => {
  const NOW = Date.parse('2026-10-25T12:00:00.000Z');
  const summary = (id: string): ChatSummary => ({
    id,
    title: id,
    project: 'shop',
    projectPath: '/w/shop',
    isSandbox: false,
    messageCount: 2,
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
  });

  it('у разговора с транскриптом — клиент из хвоста; не знаем — поля нет', () => {
    const inbox = buildInbox({
      chats: [summary('vs'), summary('old')],
      runs: [],
      permissions: [],
      lastAsked: () => undefined,
      clientOf: (chatId) => (chatId === 'vs' ? 'vscode' : undefined),
      now: NOW,
    });
    const byId = new Map(inbox.chats.map((chat) => [chat.id, chat]));
    expect(byId.get('vs')!.client).toBe('vscode');
    expect('client' in byId.get('old')!).toBe(false);
  });
});
