import { describe, it, expect, beforeEach } from 'vitest';
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
