import { describe, it, expect } from 'vitest';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { SessionStreamPage } from '@agentdeck/contracts/core/session-stream';
import { createBridgeTokenLedger } from '../../../lib/bridge-tokens/bridge-tokens.ts';
import type { CoreAskPort } from '../../core-ask/core-ask.types.ts';
import { startPanelAgentTurn } from './core-turn.ts';

/**
 * Токен моста живёт ровно ход: и у хода, который бросил. Ядро здесь — порт-заглушка (граница
 * сети); ход, токены и клиент вопроса — настоящие. Порт пускает сессию, модель зовёт чужой
 * инструмент, клиент шлёт `cancel`, а порт на нём падает — итог хода бросает.
 */
function throwingPort(seen: { tokens: number[] }, bridges: { size(): number }): CoreAskPort {
  return {
    ask: async () => {
      seen.tokens.push(bridges.size());
      return { ok: true, taskId: 't-1' };
    },
    task: async () => ({ sessions: [{ sessionId: 's-1' }], ended: false }) as unknown as TaskView,
    async *pages(): AsyncIterable<SessionStreamPage> {
      yield {
        events: [
          {
            offset: 0,
            kind: 'tool-call',
            data: { toolUseId: 'x1', name: 'Bash', input: {} },
          },
        ],
        done: false,
      } as unknown as SessionStreamPage;
    },
    cancel: async () => {
      throw new Error('core went away mid-cancel');
    },
  };
}

describe('ход агента панели: токен моста', () => {
  it('ход бросил — токен моста всё равно снят', async () => {
    const bridges = createBridgeTokenLedger();
    const seen = { tokens: [] as number[] };
    const handle = startPanelAgentTurn({
      ask: throwingPort(seen, bridges),
      bridges,
      selfBaseUrl: 'http://127.0.0.1:5213',
      conversationId: 'c-throw',
      context: { route: '/rules', title: 'Правила' },
      messages: [{ role: 'user', content: 'покажи правила' }],
      route: { adapter: 'claude' },
      onEvent: () => undefined,
      pollMs: 5,
      helpWebSrc: 'C:/nonexistent-help-src',
    });
    await expect(handle.done).rejects.toThrow('core went away mid-cancel');
    // Во время хода токен был в книге — иначе проверка снятия ничего не доказывает.
    expect(seen.tokens).toEqual([1]);
    expect(bridges.size()).toBe(0);
  });
});
