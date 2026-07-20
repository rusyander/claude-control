import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ChatRunRegistry,
  type RunLike,
  type BufferedEvent,
  type RunSubscriber,
} from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from './ChatRunner.ts';

/**
 * Реестр прогонов, отвязанный от HTTP-запроса. Настоящий CLI не запускаем —
 * подставляем управляемый фейк и проверяем ровно то, ради чего реестр появился:
 * события копятся с порядковыми номерами, к прогону можно подключиться и
 * переподключиться, догнав пропущенное, а обрыв соединения агента не убивает.
 * Тест-кейсы см. .agent/TEST-CASES.md → «Реестр прогонов чата».
 */

/** Управляемый прогон: сами шлём события и сами завершаем. */
class FakeRun implements RunLike {
  private onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;
  stopped = false;

  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  stop(): void {
    this.stopped = true;
    this.resolve?.();
  }

  /** Прислать событие как настоящий CLI. */
  emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }

  /** Процесс закрылся сам (без остановки). */
  finish(): void {
    this.resolve?.();
  }
}

/** Слушатель-накопитель: собирает события и факт закрытия. */
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

/** Дать сработать микрозадаче `.then` после завершения фейка. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const OPTIONS: RunOptions = { prompt: 'привет', cwd: '/tmp/x' };
const SESSION: ChatEvent = { kind: 'session', sessionId: 'sess-1', model: 'm', tools: 1 };

describe('ChatRunRegistry', () => {
  let fake: FakeRun;
  let registry: ChatRunRegistry;

  beforeEach(() => {
    fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
  });

  it('догоняет буфер и слушает живые события, seq растут монотонно', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(SESSION);
    fake.emit({ kind: 'text', text: 'при' });

    const { events, sub } = collector();
    const unsubscribe = registry.attach('c1', 0, sub);

    // Догнали буфер целиком.
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[0]?.event.kind).toBe('session');

    // Живое событие приходит следующим номером.
    fake.emit({ kind: 'text', text: 'вет' });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(typeof unsubscribe).toBe('function');
  });

  it('переподключение с seq отдаёт только новое', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(SESSION); // seq 1
    fake.emit({ kind: 'text', text: 'а' }); // seq 2
    fake.emit({ kind: 'text', text: 'б' }); // seq 3

    const { events, sub } = collector();
    registry.attach('c1', 2, sub); // догоняем начиная с 3-го
    expect(events.map((e) => e.seq)).toEqual([3]);
  });

  it('active() перечисляет идущий прогон с sessionId и projectPath', () => {
    registry.start('c1', OPTIONS, { projectPath: '/proj' });
    fake.emit(SESSION);

    const active = registry.active();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ chatId: 'c1', sessionId: 'sess-1', projectPath: '/proj' });
  });

  it('завершение закрывает живых слушателей, но буфер живёт для догона', async () => {
    registry.start('c1', OPTIONS, {});
    const live = collector();
    registry.attach('c1', 0, live.sub);

    fake.emit({ kind: 'text', text: 'ответ' });
    fake.emit({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-1' });
    fake.finish();
    await flush();

    // Живого слушателя закрыли, прогон больше не идёт.
    expect(live.state.closed).toBe(true);
    expect(registry.isRunning('c1')).toBe(false);

    // Догон в пределах grace возвращает буфер (включая done) и «нет живого потока».
    const late = collector();
    const unsubscribe = registry.attach('c1', 0, late.sub);
    expect(unsubscribe).toBeUndefined();
    expect(late.events.some((e) => e.event.kind === 'done')).toBe(true);
  });

  it('ошибка помечает прогон как завершённый и убирает из active()', async () => {
    registry.start('c1', OPTIONS, {});
    fake.emit({ kind: 'error', message: 'лимит' });
    fake.finish();
    await flush();

    expect(registry.isRunning('c1')).toBe(false);
    expect(registry.active()).toHaveLength(0);
  });

  it('stop убивает прогон и убирает его из реестра', () => {
    registry.start('c1', OPTIONS, {});
    expect(registry.isRunning('c1')).toBe(true);

    const ok = registry.stop('c1');
    expect(ok).toBe(true);
    expect(fake.stopped).toBe(true);
    expect(registry.has('c1')).toBe(false);
  });

  it('повторный start при идущем прогоне не плодит второй процесс', () => {
    let created = 0;
    const reg = new ChatRunRegistry(() => {
      created += 1;
      return new FakeRun();
    });
    reg.start('c1', OPTIONS, {});
    reg.start('c1', OPTIONS, {});
    expect(created).toBe(1);
  });

  it('нет прогона — attach и has() это видят', () => {
    expect(registry.has('нет')).toBe(false);
    const { sub } = collector();
    expect(registry.attach('нет', 0, sub)).toBeUndefined();
  });
});

/**
 * Счётчик расхода за сеанс сервера. Ключевое (по ТЗ): накопление идёт на
 * сервере (переживает F5 вкладки), а переподключение с догоном буфера НЕ должно
 * считать токены/деньги повторно — накопление привязано к генерации события, а
 * не к его доставке слушателю.
 */
describe('ChatRunRegistry — счётчик расхода (spend)', () => {
  let fake: FakeRun;
  let registry: ChatRunRegistry;

  beforeEach(() => {
    fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
  });

  const USAGE: ChatEvent = {
    kind: 'usage',
    input: 10,
    output: 20,
    cacheRead: 5,
    cacheCreation: 3,
  };
  const DONE = (costUsd: number): ChatEvent => ({
    kind: 'done',
    costUsd,
    durationMs: 1,
    sessionId: 'sess-1',
  });

  it('стартовый расход — нули', () => {
    expect(registry.spend()).toEqual({ costUsd: 0, tokens: 0 });
  });

  it('usage складывает все виды токенов, done — стоимость', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(USAGE); // 10+20+5+3 = 38
    fake.emit(DONE(0.25));

    expect(registry.spend()).toEqual({ costUsd: 0.25, tokens: 38 });
  });

  it('переподключение с догоном буфера НЕ удваивает расход', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(USAGE);
    fake.emit(DONE(0.25));

    const before = registry.spend();
    // Клиент переподключается и догоняет весь буфер с seq 0 — как после F5.
    const { sub } = collector();
    registry.attach('c1', 0, sub);

    // Повторная доставка тех же событий расход не меняет.
    expect(registry.spend()).toEqual(before);
  });

  it('несколько прогонов складываются в общий счётчик сеанса', () => {
    // Фабрика выдаёт свежий прогон на каждый chatId — держим ссылки, чтобы слать
    // события в нужный прогон.
    const byId = new Map<string, FakeRun>();
    let next: FakeRun;
    const reg = new ChatRunRegistry(() => {
      next = new FakeRun();
      return next;
    });

    reg.start('c1', OPTIONS, {});
    byId.set('c1', next!);
    reg.start('c2', OPTIONS, {});
    byId.set('c2', next!);

    byId.get('c1')!.emit(USAGE); // 38 токенов
    byId.get('c1')!.emit(DONE(0.1));
    byId.get('c2')!.emit(USAGE); // ещё 38 токенов
    byId.get('c2')!.emit(DONE(0.4));

    expect(reg.spend().tokens).toBe(76);
    expect(reg.spend().costUsd).toBeCloseTo(0.5, 5);
  });

  const ERROR: ChatEvent = { kind: 'error', message: 'сеть моргнула' };

  it('ретрай поверх упавшего прогона НЕ задваивает расход', async () => {
    // Свежий прогон на каждый start: упавшая попытка и её ретрай — разные процессы.
    const created: FakeRun[] = [];
    const reg = new ChatRunRegistry(() => {
      const run = new FakeRun();
      created.push(run);
      return run;
    });

    // Первая попытка: потратила токены и упала (done не пришёл — только error).
    reg.start('c1', OPTIONS, {});
    created[0]!.emit(USAGE); // 38 токенов уже осели в счётчике
    created[0]!.emit(ERROR);
    created[0]!.finish();
    await flush();
    expect(reg.spend().tokens).toBe(38);

    // Ретрай тем же chatId: вклад упавшей попытки откатывается перед повтором,
    // иначе её токены остались бы в счётчике и ретрай добавил бы ещё столько же.
    reg.start('c1', OPTIONS, {});
    expect(reg.spend()).toEqual({ costUsd: 0, tokens: 0 });

    // Повтор отработал успешно — считаем ровно его расход, без задвоения.
    created[1]!.emit(USAGE); // снова 38
    created[1]!.emit(DONE(0.25));
    created[1]!.finish();
    await flush();
    expect(reg.spend()).toEqual({ costUsd: 0.25, tokens: 38 });
  });

  it('новый ход поверх УСПЕШНОГО прогона расход НЕ теряет', async () => {
    // Обратная сторона отката: состоявшийся ход — не отменённая попытка, его
    // расход при следующем сообщении в том же чате обязан сохраниться.
    const created: FakeRun[] = [];
    const reg = new ChatRunRegistry(() => {
      const run = new FakeRun();
      created.push(run);
      return run;
    });

    reg.start('c1', OPTIONS, {});
    created[0]!.emit(USAGE);
    created[0]!.emit(DONE(0.1));
    created[0]!.finish();
    await flush();
    expect(reg.spend()).toEqual({ costUsd: 0.1, tokens: 38 });

    // Следующее сообщение, пока прошлый ход ещё в grace-буфере: расход остаётся.
    reg.start('c1', OPTIONS, {});
    expect(reg.spend()).toEqual({ costUsd: 0.1, tokens: 38 });
    created[1]!.emit(USAGE);
    created[1]!.emit(DONE(0.2));
    created[1]!.finish();
    await flush();
    expect(reg.spend().tokens).toBe(76);
    expect(reg.spend().costUsd).toBeCloseTo(0.3, 5);
  });
});

/**
 * Внешние события (запрос прав приходит не от CLI, а от MCP-сервера через HTTP)
 * и жизненный цикл буфера после завершения.
 */
describe('ChatRunRegistry — emitExternal и grace-период', () => {
  let fake: FakeRun;
  let registry: ChatRunRegistry;

  beforeEach(() => {
    fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
  });

  const PERMISSION: ChatEvent = {
    kind: 'permission',
    toolName: 'Bash',
    input: { command: 'ls' },
    toolUseId: 'tu1',
  };

  it('emitExternal возвращает false, когда прогона нет', () => {
    expect(registry.emitExternal('нет', PERMISSION)).toBe(false);
  });

  it('emitExternal буферизует событие и доставляет живому слушателю с новым seq', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(SESSION); // seq 1

    const { events, sub } = collector();
    registry.attach('c1', 1, sub); // догон с 1 — буфер пуст, ждём живое

    expect(registry.emitExternal('c1', PERMISSION)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(2);
    expect(events[0]?.event.kind).toBe('permission');
  });

  it('завершённый прогон живёт в буфере, но убирается по истечении grace-периода', async () => {
    vi.useFakeTimers();
    try {
      registry.start('c1', OPTIONS, {});
      fake.emit(DONE_EVENT);
      fake.finish();
      // Дать сработать .then(() => finish()) — он и ставит cleanupTimer.
      await vi.advanceTimersByTimeAsync(0);

      // Сразу после завершения буфер ещё на месте — для догона хвоста после F5.
      expect(registry.has('c1')).toBe(true);
      expect(registry.isRunning('c1')).toBe(false);

      // Не дошли до конца grace — прогон всё ещё в буфере.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(registry.has('c1')).toBe(true);

      // Grace истёк (60 c) — прогон убран, догонять больше нечего.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(registry.has('c1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('active() отдаёт недавно завершённый УСПЕШНЫЙ прогон (догон хвоста после F5)', async () => {
    vi.useFakeTimers();
    try {
      registry.start('c1', OPTIONS, { projectPath: '/proj' });
      fake.emit(SESSION);
      fake.emit(DONE_EVENT);
      fake.finish();
      // Дать сработать .then(() => finish()) — он и ставит finishedAt + cleanupTimer.
      await vi.advanceTimersByTimeAsync(0);

      // Прогон уже не идёт, но лежит в grace-буфере — active() его отдаёт, чтобы
      // клиент дотянул терминальный хвост, если вкладка была закрыта в финиш.
      expect(registry.isRunning('c1')).toBe(false);
      expect(registry.active().map((r) => r.chatId)).toContain('c1');

      // За пределами grace прогон убран из буфера — возвращать больше нечего.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(registry.has('c1')).toBe(false);
      expect(registry.active()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('active() НЕ воскрешает упавший прогон, даже пока он в grace-буфере', async () => {
    registry.start('c1', OPTIONS, {});
    fake.emit({ kind: 'error', message: 'сбой' });
    fake.finish();
    await flush();

    // В буфере ещё лежит (ошибку можно дочитать перечитыванием истории), но
    // повторно стримить её через active() не будем — иначе поток отдаст ошибку заново.
    expect(registry.has('c1')).toBe(true);
    expect(registry.active()).toHaveLength(0);
  });

  it('stopAll останавливает все прогоны и очищает реестр', () => {
    const created: FakeRun[] = [];
    const reg = new ChatRunRegistry(() => {
      const run = new FakeRun();
      created.push(run);
      return run;
    });
    reg.start('c1', OPTIONS, {});
    reg.start('c2', OPTIONS, {});

    reg.stopAll();

    expect(reg.has('c1')).toBe(false);
    expect(reg.has('c2')).toBe(false);
    expect(created.every((run) => run.stopped)).toBe(true);
  });
});

const DONE_EVENT: ChatEvent = { kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-1' };

afterEach(() => {
  vi.useRealTimers();
});
