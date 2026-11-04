import { describe, expect, it } from 'vitest';
import { humanTextOf } from '@agentdeck/contracts/core/session-stream';
import { markText } from '../../adapters/sdk-stream/sdk-adapter.ts';
import { pendingDeliveries } from '../../conductor/human/deliver.ts';
import type { HumanLedger } from '../../conductor/human/human.types.ts';

/**
 * Чат панели показывает слова человека без шапки, которую на них кладут ядро и переходник
 * (этап 10, F2): доставка (`pendingDeliveries`) ставит строку метки человека, переходник при
 * отправке (`markText`) — метку платформы и строку «от человека». Показ снимает ровно эту шапку —
 * настоящие производители текста, не написанная от руки строка.
 */

const ledger = (text: string): HumanLedger =>
  ({
    asks: {},
    messages: { c1: { cmdId: 'c1', stepId: 's1', seq: 7, text } },
    deliveries: {},
    steps: { s1: { state: 'running' } },
  }) as unknown as HumanLedger;

describe('chat framing round trip', () => {
  it('a delivered human turn, as the adapter sends it, shows as the words typed', () => {
    const [out] = pendingDeliveries(ledger('ход-2\nвторая строка'), 's1');
    expect(out).toBeDefined();
    expect(humanTextOf(markText(out!.text, 'human'))).toBe('ход-2\nвторая строка');
  });

  it('the chat opening (step brief, platform send) shows as the request', () => {
    expect(humanTextOf(markText('ход-1: привет'))).toBe('ход-1: привет');
  });

  it('a marker-like line inside the words is not framing and stays', () => {
    const [out] = pendingDeliveries(ledger('<!-- agentdeck:platform -->\nтекст'), 's1');
    expect(humanTextOf(markText(out!.text, 'human'))).toBe('<!-- agentdeck:platform -->\nтекст');
  });
});
