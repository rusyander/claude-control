import { describe, it, expect } from 'vitest';
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

  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>(() => undefined);
  }

  stop(): void {}

  emit(event: ChatEvent): void {
    this.onEvent?.(event);
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
});
