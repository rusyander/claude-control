import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatSummary } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import {
  translate,
  type ChatEvent,
  type RunOptions,
} from '../../../domains/chat/ChatRunner/ChatRunner.ts';
import type { RawEvent } from '../../../domains/chat/chat-events.ts';
import {
  appendLimitRun,
  readLimitRuns,
} from '../../../domains/chat/limit-journal/limit-journal.ts';
import { registerChatTranscriptRoutes } from './transcript-routes.ts';

/**
 * Доля окна лимита у звена группы — весь путь сервера: строка `rate_limit_event`
 * разбирается тем же `translate`, что и поток CLI, реестр копит замеры и токены
 * прогона, на завершении журнал ложится файлом в каталог данных, а список чатов
 * читает его и отдаёт `limitShare`. Подменён только процесс CLI.
 *
 * Рядом с группой идёт обычный чат: загрузка окна общая, и группе достаётся не
 * весь прирост 0,10, а её часть по токенам — 0,075.
 */
class FakeRun implements RunLike {
  private onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;

  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  stop(): void {
    this.resolve?.();
  }

  emitRaw(raw: RawEvent): void {
    for (const event of translate(raw)) this.onEvent?.(event);
  }

  emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }

  finish(): void {
    this.resolve?.();
  }
}

const OPTIONS: RunOptions = { prompt: 'привет', cwd: '/tmp/x' };
const RESETS = 1_800_000_000;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const limitRaw = (fiveHour: number): RawEvent => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: RESETS,
    rateLimitType: 'five_hour',
    unifiedWindows: { five_hour: { utilization: fiveHour, resetsAt: RESETS } },
  },
});

const usage = (output: number): ChatEvent => ({
  kind: 'usage',
  input: 0,
  output,
  cacheRead: 0,
  cacheCreation: 0,
  toolIds: [],
});

describe('GET /api/chats — доля окна лимита у звена группы', () => {
  let root: string;
  let appData: string;
  let app: FastifyInstance;
  let store: AppStore;
  let clock: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-limit-share-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    store = new AppStore(appData);
    const ctx = {
      store,
      location: { paths: { root, appData } },
      pricing: { current: () => ({ entries: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatTranscriptRoutes(app, ctx);
    await app.ready();
    clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  function transcript(chatId: string): void {
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const record = {
      type: 'user',
      uuid: `u-${chatId}`,
      sessionId: chatId,
      cwd: join(root, 'work'),
      timestamp: '2026-10-19T10:00:00.000Z',
      message: { role: 'user', content: 'Поправь вход' },
    };
    writeFileSync(join(dir, `${chatId}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  async function list(): Promise<Map<string, ChatSummary>> {
    const response = await app.inject({ method: 'GET', url: '/api/chats' });
    expect(response.statusCode).toBe(200);
    return new Map(response.json<ChatSummary[]>().map((chat) => [chat.id, chat]));
  }

  it('прирост окна делится с чатом, шедшим рядом, по токенам; журнал переживает перезапуск', async () => {
    const runs = new Map<string, FakeRun>();
    const registry = new ChatRunRegistry(() => {
      const run = new FakeRun();
      runs.set(`run-${runs.size}`, run);
      return run;
    });
    registry.setLimitJournal((record) => appendLimitRun(appData, record));

    registry.start('g-1', OPTIONS, {});
    registry.start('p-1', OPTIONS, {});
    const group = runs.get('run-0');
    const plain = runs.get('run-1');
    if (!group || !plain) throw new Error('прогоны не заведены');
    group.emit({ kind: 'session', sessionId: 'g-1', model: 'm', tools: 0 });
    plain.emit({ kind: 'session', sessionId: 'p-1', model: 'm', tools: 0 });

    clock = 1_001_000;
    group.emitRaw(limitRaw(0.1));
    group.emit(usage(3000));
    plain.emit(usage(1000));
    clock = 1_009_000;
    plain.emitRaw(limitRaw(0.18));
    clock = 1_010_000;
    group.emitRaw(limitRaw(0.2));
    group.finish();
    plain.finish();
    await flush();

    // Записи легли файлом: после перезапуска панели их больше неоткуда взять.
    const records = readLimitRuns(appData);
    expect(records.map((record) => record.sessionId).sort()).toEqual(['g-1', 'p-1']);
    expect(records.find((record) => record.sessionId === 'g-1')?.samples).toHaveLength(2);

    transcript('g-1');
    transcript('p-1');
    store.setChatLink('g-1', {
      parentChatId: 'parent',
      groupIndex: 0,
      createdAt: '2026-10-19T10:00:00.000Z',
    });
    const chats = await list();
    const share = chats.get('g-1')?.limitShare;
    expect(share?.fiveHour).toBeCloseTo(0.075, 6);
    expect(share?.sevenDay).toBeUndefined();
    // Обычный чат свою четверть забрал, но карточки группы у него нет — и поля тоже.
    expect(chats.get('p-1')?.limitShare).toBeUndefined();
  });

  it('CLI без `unifiedWindows` замеров не даёт — у звена поля нет, а не «0»', async () => {
    let run: FakeRun | undefined;
    const registry = new ChatRunRegistry(() => {
      run = new FakeRun();
      return run;
    });
    registry.setLimitJournal((record) => appendLimitRun(appData, record));
    registry.start('g-2', OPTIONS, {});
    run?.emit({ kind: 'session', sessionId: 'g-2', model: 'm', tools: 0 });
    run?.emitRaw({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed', resetsAt: RESETS, rateLimitType: 'five_hour' },
    });
    run?.emit(usage(500));
    clock = 1_005_000;
    run?.finish();
    await flush();

    expect(readLimitRuns(appData)[0]?.samples).toEqual([]);
    transcript('g-2');
    store.setChatLink('g-2', {
      parentChatId: 'parent',
      groupIndex: 0,
      createdAt: '2026-10-19T10:00:00.000Z',
    });
    expect((await list()).get('g-2')?.limitShare).toBeUndefined();
  });

  it('замеры ложатся в журнал посреди прогона, а не только на его конце (W.1)', async () => {
    let run: FakeRun | undefined;
    const registry = new ChatRunRegistry(() => {
      run = new FakeRun();
      return run;
    });
    registry.setLimitJournal((record) => appendLimitRun(appData, record));
    registry.start('g-3', OPTIONS, {});
    run?.emit({ kind: 'session', sessionId: 'g-3', model: 'm', tools: 0 });

    clock = 1_001_000;
    run?.emitRaw(limitRaw(0.1));
    run?.emit(usage(3000));
    // Через пять минут после первой записи (каденция журнала, F-71) — снова на диск.
    clock = 1_301_000;
    run?.emitRaw(limitRaw(0.15));
    // Звено ещё работает — запись уже в файле, с обоими замерами и токенами.
    const midRun = readLimitRuns(appData);
    expect(midRun).toHaveLength(1);
    expect(midRun[0]?.samples.map((sample) => sample.fiveHour?.utilization)).toEqual([0.1, 0.15]);
    expect(midRun[0]?.tokens).toBe(3000);
    expect(midRun[0]?.endedAt).toBe(1_301_000);

    // Чаще раза в пять минут файл не переписывается; замер не теряется — он в памяти.
    clock = 1_306_000;
    run?.emitRaw(limitRaw(0.2));
    expect(readLimitRuns(appData)[0]?.samples).toHaveLength(2);

    clock = 1_310_000;
    run?.finish();
    await flush();
    // Конец прогона заменяет ту же запись, а не дописывает вторую.
    const final = readLimitRuns(appData);
    expect(final).toHaveLength(1);
    expect(final[0]?.id).toBe(midRun[0]?.id);
    expect(final[0]?.samples.map((sample) => sample.fiveHour?.utilization)).toEqual([
      0.1, 0.15, 0.2,
    ]);
  });
});
