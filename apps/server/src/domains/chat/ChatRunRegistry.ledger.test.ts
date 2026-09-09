import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ADOPTED_SEQ_BASE,
  ChatRunRegistry,
  type RunLedgerSink,
  type RunLike,
  type BufferedEvent,
  type RunSubscriber,
} from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from './ChatRunner.ts';
import type { RunLedgerEntry } from './run-ledger.ts';

/**
 * Реестр и журнал на диске: что реестр пишет о прогоне, когда убирает запись, и
 * как усыновляет прогон из журнала после перезапуска панели — с картой прав,
 * местом в `/chat/active`, остановкой по pid и концом по его смерти, но без
 * планировщика продолжений и журнала сдачи (текста ответа у такого прогона нет).
 */

class FakeRun implements RunLike {
  pid?: number;
  private onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;

  constructor(pid?: number) {
    this.pid = pid;
  }

  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  stop(): void {
    this.resolve?.();
  }

  emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }

  finish(): void {
    this.resolve?.();
  }
}

class FakeLedger implements RunLedgerSink {
  readonly entries = new Map<string, RunLedgerEntry>();
  upsert(entry: RunLedgerEntry): void {
    this.entries.set(entry.key, entry);
  }
  remove(key: string): void {
    this.entries.delete(key);
  }
}

function collector() {
  const events: BufferedEvent[] = [];
  const state = { closed: false };
  const sub: RunSubscriber = {
    send: (buffered) => events.push(buffered),
    close: () => {
      state.closed = true;
    },
  };
  return { events, state, sub };
}

const flush = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const OPTIONS: RunOptions = { prompt: 'привет', cwd: '/proj', model: 'sonnet', effort: 'high' };
const SESSION: ChatEvent = { kind: 'session', sessionId: 'sess-1', model: 'm', tools: 1 };

describe('ChatRunRegistry — запись в журнал', () => {
  let fake: FakeRun;
  let ledger: FakeLedger;
  let registry: ChatRunRegistry;
  let toggles: { enabled: boolean; allowEdits: boolean } | undefined;

  beforeEach(() => {
    fake = new FakeRun(777);
    ledger = new FakeLedger();
    toggles = { enabled: true, allowEdits: false };
    registry = new ChatRunRegistry(() => fake);
    registry.setLedger(ledger, () => toggles);
  });

  afterEach(() => registry.stopAll());

  it('старт пишет ключ, pid, каталог, модель, понижение и снимок тумблеров', () => {
    registry.start('c1', OPTIONS, {
      projectPath: '/proj',
      lowered: { model: 'claude-sonnet-5', effort: 'low', kind: 'tests' },
    });

    expect(ledger.entries.get('c1')).toEqual({
      key: 'c1',
      projectPath: '/proj',
      cwd: '/proj',
      pid: 777,
      startedAt: expect.any(Number),
      model: 'sonnet',
      effort: 'high',
      lowered: { model: 'claude-sonnet-5', effort: 'low', kind: 'tests' },
      autoApprove: { enabled: true, allowEdits: false },
    });
  });

  it('найденный под оболочкой pid CLI переписывает запись; сама оболочка остаётся для остановки', async () => {
    registry.setLedger(
      ledger,
      () => toggles,
      async (wrapper) => wrapper + 1000,
    );
    registry.start('c1', OPTIONS, { projectPath: '/proj' });
    expect(ledger.entries.get('c1')?.pid).toBe(777);

    await flush();
    expect(ledger.entries.get('c1')?.pid).toBe(1777);
    // Пересчёт тумблеров на ходу не возвращает номер оболочки.
    registry.persist('c1');
    expect(ledger.entries.get('c1')?.pid).toBe(1777);
  });

  it('поиск CLI провалился или вернул ту же оболочку — запись не трогается, ничего не падает', async () => {
    registry.setLedger(
      ledger,
      () => toggles,
      async () => {
        throw new Error('нет powershell');
      },
    );
    registry.start('c1', OPTIONS, { projectPath: '/proj' });
    await flush();
    expect(ledger.entries.get('c1')?.pid).toBe(777);
  });

  it('без pid запись всё равно есть, но без поля pid — усыновлять её не станут', () => {
    fake = new FakeRun(undefined);
    registry.start('c1', OPTIONS, {});
    expect(ledger.entries.get('c1')).not.toHaveProperty('pid');
  });

  it('событие сессии дописывает второе написание ключа', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(SESSION);
    expect(ledger.entries.get('c1')?.sessionId).toBe('sess-1');
  });

  it('persist переписывает снимок тумблеров на ходу — и по sessionId тоже', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(SESSION);
    toggles = { enabled: false, allowEdits: true };
    registry.persist('sess-1');
    expect(ledger.entries.get('c1')?.autoApprove).toEqual({ enabled: false, allowEdits: true });
    // Ключ записи — тот, под которым прогон стартовал, а не синоним.
    expect(ledger.entries.has('sess-1')).toBe(false);
  });

  it('завершение убирает запись: усыновлять мёртвое нечего', async () => {
    registry.start('c1', OPTIONS, {});
    fake.finish();
    await flush();
    expect(ledger.entries.size).toBe(0);
  });

  it('остановка по кнопке тоже убирает запись', () => {
    registry.start('c1', OPTIONS, {});
    registry.stop('c1');
    expect(ledger.entries.size).toBe(0);
  });

  it('без журнала реестр работает как раньше', () => {
    const bare = new ChatRunRegistry(() => new FakeRun(1));
    expect(bare.start('c1', OPTIONS, {})).toBe(true);
    expect(() => bare.persist('c1')).not.toThrow();
    bare.stopAll();
  });
});

describe('ChatRunRegistry — усыновление после перезапуска', () => {
  let ledger: FakeLedger;
  let registry: ChatRunRegistry;
  let alive: boolean;
  let kill: (pid: number) => void;

  const ENTRY: RunLedgerEntry = {
    key: 'new-1',
    sessionId: 'sess-1',
    projectPath: '/proj',
    cwd: '/proj/sub',
    pid: 4242,
    startedAt: 1_000,
    model: 'claude-opus-5',
    effort: 'high',
    lowered: { model: 'claude-sonnet-5', effort: 'low', kind: 'tests' },
  };

  const adopt = (entry: RunLedgerEntry = ENTRY): boolean =>
    registry.adopt(entry, { isAlive: () => alive, kill, pollMs: 20 });

  beforeEach(() => {
    alive = true;
    kill = vi.fn();
    ledger = new FakeLedger();
    ledger.upsert(ENTRY);
    registry = new ChatRunRegistry(() => {
      throw new Error('усыновление не запускает CLI');
    });
    registry.setLedger(ledger);
  });

  afterEach(() => registry.stopAll());

  it('встаёт в реестр под прежним ключом: active() с меткой detached, находится по sessionId', () => {
    expect(adopt()).toBe(true);

    expect(registry.active()).toEqual([
      {
        chatId: 'new-1',
        sessionId: 'sess-1',
        projectPath: '/proj',
        seq: ADOPTED_SEQ_BASE + 2,
        startedAt: 1_000,
        status: 'running',
        finishedAt: undefined,
        model: 'claude-opus-5',
        detached: true,
      },
    ]);
    expect(registry.isRunning('sess-1')).toBe(true);
    expect(registry.resolveKey('sess-1')).toBe('new-1');
    // Второй прогон на тот же разговор не поднять: процесс ещё жив.
    expect(registry.start('sess-1', { prompt: 'ещё', cwd: '/proj' }, {})).toBe(false);
  });

  it('поток начинается с сессии (со временем старта) и заметки о подхвате', () => {
    adopt();
    const { events, sub } = collector();
    registry.attach('sess-1', 0, sub);

    expect(events.map((item) => item.event.kind)).toEqual(['session', 'notice']);
    const session = events[0]?.event;
    expect(session?.kind === 'session' ? session.startedAt : undefined).toBe(1_000);
    const notice = events[1]?.event;
    expect(notice?.kind === 'notice' ? notice.code : undefined).toBe('adopted');
  });

  it('вкладка с номером из прежней жизни сервера всё равно получает сессию и заметку', () => {
    adopt();
    const { events, sub } = collector();
    // from=7 — последний seq, который вкладка видела до перезапуска.
    registry.attach('sess-1', 7, sub);

    expect(events.map((item) => item.event.kind)).toEqual(['session', 'notice']);
    expect(events.every((item) => item.seq > ADOPTED_SEQ_BASE)).toBe(true);
  });

  it('запрос прав рисует карточку в потоке и дёргает уведомление', () => {
    const notify = vi.fn();
    registry.setNotifier(notify);
    adopt();
    const { events, sub } = collector();
    registry.attach('new-1', 0, sub);

    const shown = registry.emitExternal('new-1', {
      kind: 'permission',
      toolName: 'Bash',
      input: { command: 'cp a b' },
      toolUseId: 'toolu_1',
    });

    expect(shown).toBe(true);
    expect(events.at(-1)?.event.kind).toBe('permission');
    expect(notify).toHaveBeenCalledWith({
      kind: 'permission',
      chatId: 'new-1',
      projectPath: '/proj',
      toolName: 'Bash',
    });
  });

  it('смерть pid закрывает прогон: заметка и done, слушатели закрыты, планировщик и журнал сдачи молчат', async () => {
    const plan = vi.fn(() => undefined);
    const journal = vi.fn();
    const notify = vi.fn();
    registry.setHandoffPlanner(plan);
    registry.setLoweredJournal(journal);
    registry.setNotifier(notify);
    adopt();
    const { events, state, sub } = collector();
    registry.attach('new-1', 0, sub);

    alive = false;
    await flush(60);

    const kinds = events.map((item) => item.event.kind);
    expect(kinds.slice(-2)).toEqual(['notice', 'done']);
    expect(state.closed).toBe(true);
    expect(plan).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith({ kind: 'done', chatId: 'new-1', projectPath: '/proj' });
    expect(ledger.entries.has('new-1')).toBe(false);
    // В grace-буфере — как обычный завершённый: вкладка дотянет хвост после F5.
    expect(registry.active()[0]?.status).toBe('done');
  });

  it('«Остановить» валит дерево по pid и убирает прогон вместе с записью', () => {
    adopt();
    expect(registry.stop('sess-1')).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242);
    expect(registry.active()).toEqual([]);
    expect(ledger.entries.has('new-1')).toBe(false);
  });

  it('без pid и при занятом ключе усыновление отказывает', () => {
    expect(adopt({ ...ENTRY, pid: undefined })).toBe(false);
    expect(adopt()).toBe(true);
    expect(adopt()).toBe(false);
  });

  it('запись без sessionId усыновляется по одному ключу — без события сессии', () => {
    adopt({ ...ENTRY, sessionId: undefined });
    const { events, sub } = collector();
    registry.attach('new-1', 0, sub);
    expect(events.map((item) => item.event.kind)).toEqual(['notice']);
    expect(registry.active()[0]?.sessionId).toBeUndefined();
  });
});
