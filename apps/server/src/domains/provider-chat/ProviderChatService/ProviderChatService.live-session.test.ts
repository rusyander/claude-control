import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { ProviderChatService } from './ProviderChatService.ts';
import type {
  ProviderChatRunEvent,
  ProviderChatRunLike,
  ProviderChatRunOptions,
} from '../ProviderChatRun/ProviderChatRun.ts';
import {
  createChat,
  deleteChat,
  dropMessage,
  readChat,
  readChatLiveSession,
  writeChatLiveSession,
} from '../store/store.ts';
import { digestMessages } from '../live-session/live-session.ts';

/**
 * @covers ProviderChatService.ts — `rememberLiveSession`, `dropLiveSession`, сверка перед ходом (E2b)
 * @covers store.ts — `readChatLiveSession`, `writeChatLiveSession`, `deleteChat`
 * @scenario служба запоминает сессию CLI после ответа (сколько реплик она видела
 *   и их отпечаток), отдаёт её следующему ходу, пока переписка, модель и каталог
 *   те же, и делает непригодной после ошибки.
 */

class FakeRun implements ProviderChatRunLike {
  emit?: (event: ProviderChatRunEvent) => void;
  options?: ProviderChatRunOptions;
  finish: () => void = () => {};
  start(options: ProviderChatRunOptions, onEvent: (event: ProviderChatRunEvent) => void) {
    this.options = options;
    this.emit = onEvent;
    return new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }
  stop(): void {}
}

const PROVIDER = { id: 'codex', name: 'Codex' } as ConfigProvider;
const SESSION = { kind: 'codex-app-server', id: 'thr-1', preamble: 'P' };

describe('ProviderChatService: сессия CLI между ходами', () => {
  let dir: string;
  let run: FakeRun;
  let service: ProviderChatService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-live-session-'));
    run = new FakeRun();
    service = new ProviderChatService(() => run);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const send = (text: string) => {
    run = new FakeRun();
    service.send(dir, 'codex', 'chat', { text }, { provider: PROVIDER });
    return run;
  };
  const answer = (current: FakeRun, event: Partial<ProviderChatRunEvent> = {}) => {
    current.emit?.({ type: 'done', reply: 'Ответ', transport: 'live', ...event } as never);
    current.finish();
  };

  it('первый ход идёт с пустой отметкой; ответ с сессией — отметка о двух репликах', () => {
    createChat(dir, 'codex', { id: 'chat' });
    const first = send('Первый');
    expect(first.options?.liveSession).toEqual({});

    answer(first, { liveSession: SESSION });
    const messages = readChat(dir, 'codex', 'chat')!.messages;
    expect(readChatLiveSession(dir, 'codex', 'chat')).toEqual({
      ...SESSION,
      covered: 2,
      digest: digestMessages(messages),
      model: '',
      workdir: '',
    });
  });

  it('следующий ход получает сессию с числом увиденных реплик', () => {
    createChat(dir, 'codex', { id: 'chat', model: 'gpt-x', workdir: dir });
    answer(send('Первый'), { liveSession: SESSION });
    const second = send('Второй');
    expect(second.options?.liveSession).toEqual({
      previous: { kind: SESSION.kind, id: SESSION.id, covered: 2, preamble: 'P' },
    });
  });

  it('удалённая из переписки реплика — сессию только удалить', () => {
    createChat(dir, 'codex', { id: 'chat' });
    answer(send('Первый'), { liveSession: SESSION });
    const first = readChat(dir, 'codex', 'chat')!.messages[0]!;
    dropMessage(dir, 'codex', 'chat', first.id);
    expect(send('Второй').options?.liveSession).toEqual({
      previous: { kind: SESSION.kind, id: SESSION.id },
    });
  });

  it('другая модель разговора — сессию только удалить', () => {
    createChat(dir, 'codex', { id: 'chat', model: 'gpt-x' });
    answer(send('Первый'), { liveSession: SESSION });
    const mark = readChatLiveSession(dir, 'codex', 'chat')!;
    writeChatLiveSession(dir, 'codex', 'chat', { ...mark, model: 'gpt-old' });
    expect(send('Второй').options?.liveSession).toEqual({
      previous: { kind: SESSION.kind, id: SESSION.id },
    });
  });

  it('другой каталог — сессию только удалить', () => {
    createChat(dir, 'codex', { id: 'chat', workdir: dir });
    answer(send('Первый'), { liveSession: SESSION });
    const mark = readChatLiveSession(dir, 'codex', 'chat')!;
    writeChatLiveSession(dir, 'codex', 'chat', { ...mark, workdir: join(dir, 'other') });
    expect(send('Второй').options?.liveSession).toEqual({
      previous: { kind: SESSION.kind, id: SESSION.id },
    });
  });

  it('ошибка хода делает отметку непригодной, id остаётся для удаления', () => {
    createChat(dir, 'codex', { id: 'chat' });
    answer(send('Первый'), { liveSession: SESSION });
    const failing = send('Второй');
    failing.emit?.({ type: 'error', error: 'упал', reason: 'cli_error' });
    failing.finish();

    expect(readChatLiveSession(dir, 'codex', 'chat')).toEqual({
      kind: SESSION.kind,
      id: SESSION.id,
      stale: true,
    });
    expect(send('Третий').options?.liveSession).toEqual({
      previous: { kind: SESSION.kind, id: SESSION.id },
    });
  });

  it('ответ без сессии (одиночный запуск) прежнюю отметку не трогает', () => {
    createChat(dir, 'codex', { id: 'chat' });
    answer(send('Первый'), { liveSession: SESSION });
    const before = readChatLiveSession(dir, 'codex', 'chat');
    answer(send('Второй'), { transport: 'stream' });

    expect(readChatLiveSession(dir, 'codex', 'chat')).toEqual(before);
    // Ход одиночным запуском — реплики после увиденных, сессия их ещё получит.
    expect(send('Третий').options?.liveSession).toEqual({
      previous: { kind: SESSION.kind, id: SESSION.id, covered: 2, preamble: 'P' },
    });
  });

  it('удаление разговора уносит и отметку; список разговоров её не видит', () => {
    createChat(dir, 'codex', { id: 'chat' });
    answer(send('Первый'), { liveSession: SESSION });
    const providerDir = join(dir, 'provider-chats', 'codex');
    expect(readdirSync(providerDir).sort()).toEqual(['chat.jsonl', 'chat.live.json']);

    expect(deleteChat(dir, 'codex', 'chat')).toBe(true);
    expect(existsSync(join(providerDir, 'chat.live.json'))).toBe(false);
  });
});
