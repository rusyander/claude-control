import { describe, it, expect, vi } from 'vitest';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import { ChatSession } from './ChatSession.ts';
import type { ChatEvent, RunOptions } from './ChatRunner.ts';

/**
 * Тумблеры и права по обоим написаниям ключа разговора.
 *
 * Прогон заводится под временным `new-…`, а вкладка, открывшая тот же разговор
 * из списка, знает его по sessionId. Щелчок тумблера и решение по правам из
 * такой вкладки обязаны попасть в прогон под `new-…` — иначе автоподтверждение
 * «не действует», а карточка прав висит без ответа.
 */
class FakeRun implements RunLike {
  private onEvent?: (event: ChatEvent) => void;

  /** Закрытие процесса: пока не вызвано, прогон в реестре считается идущим. */
  private finish?: () => void;

  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }

  stop(): void {}

  emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }

  end(): void {
    this.finish?.();
  }
}

const OPTIONS: RunOptions = { prompt: 'привет', cwd: 'C:/work/app' };

function arrange() {
  const fake = new FakeRun();
  const registry = new ChatRunRegistry(() => fake);
  const session = new ChatSession(registry);
  registry.start('new-1', OPTIONS, {});
  fake.emit({ kind: 'session', sessionId: 'sess-1', model: 'opus', tools: 0 });
  session.armAutoApprove('new-1', { enabled: false, allowEdits: true });
  return { registry, session };
}

describe('ChatSession — синонимы ключа', () => {
  it('тумблер, щёлкнутый по sessionId, действует на прогон под new-…', () => {
    const { session } = arrange();
    session.toggleAutoApprove('sess-1', true);
    expect(session.autoApproveFor('new-1')).toEqual({ enabled: true, allowEdits: true });
    expect(session.autoApproveFor('sess-1')).toEqual({ enabled: true, allowEdits: true });
  });

  it('решение по правам, принятое по sessionId, доходит до запроса под new-…', async () => {
    const { session } = arrange();
    const pending = session.requestPermission({
      runId: 'new-1',
      toolName: 'Bash',
      input: {},
      toolUseId: 'tu1',
    });
    expect(session.decidePermission('sess-1', 'tu1', { behavior: 'allow' })).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: 'allow' });
  });

  it('остановка по sessionId снимает тумблер и висящие запросы прогона под new-…', async () => {
    const { session } = arrange();
    const pending = session.requestPermission({
      runId: 'new-1',
      toolName: 'Bash',
      input: {},
      toolUseId: 'tu1',
    });
    session.abort('sess-1');
    expect(session.autoApproveFor('new-1')).toBeUndefined();
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('новый разговор наследует тумблеры закрытого — по любому из его ключей', () => {
    const { session } = arrange();
    session.toggleAutoApprove('new-1', true);
    session.inherit(['sess-1'], 'new-2');
    expect(session.autoApproveFor('new-2')).toEqual({ enabled: true, allowEdits: true });
  });

  /**
   * Разделение приходит ПОЗЖЕ конца родительского прогона: человек читает
   * карточку и решает. Через минуту завершённый прогон уходит из реестра
   * (`GRACE_MS`), и свести sessionId с временным ключом `new-…`, под которым
   * взведён тумблер, больше нечем — дети веера оставались без
   * автоподтверждения и вставали на первом же инструменте, ожидая человека,
   * который по построению смотрит в другую вкладку. Живой прогон 07.09.2026.
   */
  it('дети разделения наследуют тумблер и через минуту после конца прогона родителя', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeRun();
      const registry = new ChatRunRegistry(() => fake);
      const session = new ChatSession(registry);
      registry.start('new-1', OPTIONS, {});
      fake.emit({ kind: 'session', sessionId: 'sess-1', model: 'opus', tools: 0 });
      session.armAutoApprove('new-1', { enabled: true, allowEdits: true });

      fake.end();
      await vi.advanceTimersByTimeAsync(61_000);

      // Карточка знает разговор по sessionId — им и приходит `parentChatId`.
      session.inherit(['sess-1'], 'new-2');
      expect(session.autoApproveFor('new-2')).toEqual({ enabled: true, allowEdits: true });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Между предложением и нажатием «Разделить» человек успевает написать в
   * ДРУГОЙ чат — панель ровно для этого и сделана. Прежняя чистка карты
   * выбрасывала тогда запись родителя (его прогон уже не идёт), и дети снова
   * оставались без тумблера.
   */
  it('чужой прогон между предложением и разделением не стирает тумблер родителя', async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeRun();
      const registry = new ChatRunRegistry(() => fake);
      const session = new ChatSession(registry);
      registry.start('new-1', OPTIONS, {});
      fake.emit({ kind: 'session', sessionId: 'sess-1', model: 'opus', tools: 0 });
      session.armAutoApprove('new-1', { enabled: true, allowEdits: true });
      fake.end();
      await vi.advanceTimersByTimeAsync(61_000);

      // Человек ушёл писать в соседний чат — и вернулся нажать «Разделить».
      session.armAutoApprove('other-1', { enabled: false, allowEdits: false });
      session.inherit(['sess-1'], 'new-2');
      expect(session.autoApproveFor('new-2')).toEqual({ enabled: true, allowEdits: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
