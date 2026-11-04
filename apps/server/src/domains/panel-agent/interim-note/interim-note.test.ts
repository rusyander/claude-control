import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import type { SessionStreamEvent } from '@agentdeck/contracts/core/session-stream';
import { createBridgeTokenLedger } from '../../../lib/bridge-tokens/bridge-tokens.ts';
import { createCoreAskPort } from '../../core-ask/core-ask.ts';
import { startFakeCore, type FakeCore } from '../../core-ask/__fixtures__/fake-core.ts';
import { startPanelAgentTurn } from '../core-turn/core-turn.ts';

/**
 * Живой прогон 26.09: в русском разговоре лента показывала «Need the rule id;
 * list rules.» и «Look at the target first.» — строка промпта про язык держала
 * лишь часть ходов. Проверка идёт через сам ход (`startPanelAgentTurn`) и настоящий
 * клиент ядра; ядро — заглушка на HTTP, вид сеанса тот же, что пишет ядро о ходе CLI.
 */
type Line = Omit<SessionStreamEvent, 'offset'>;
let script: Line[] = [];
let core: FakeCore;

beforeAll(async () => {
  core = await startFakeCore({ turn: async ({ emit }) => emit(...script) });
});
afterAll(async () => core.close());

const text = (value: string): Line => ({ kind: 'assistant-text', data: { text: value } });
const tool = (id: string, name: string): Line => ({
  kind: 'tool-call',
  data: { toolUseId: id, name: `mcp__panel-bridge__${name}`, input: {} },
});
const toolResult = (id: string): Line => ({
  kind: 'tool-result',
  data: { toolUseId: id, isError: false },
});
const end: Line = { kind: 'turn-end', data: { isError: false, numTurns: 1 } };

async function run(userText: string, lines: Line[]): Promise<PanelAgentRunEvent[]> {
  script = lines;
  const events: PanelAgentRunEvent[] = [];
  const handle = startPanelAgentTurn({
    ask: createCoreAskPort(() => core.home, core.identity),
    bridges: createBridgeTokenLedger(),
    selfBaseUrl: 'http://127.0.0.1:5213',
    conversationId: 'c1',
    context: { route: '/rules', title: 'Правила' },
    messages: [{ role: 'user', content: userText }],
    route: { adapter: 'claude' },
    onEvent: (event) => events.push(event),
    pollMs: 20,
  });
  await handle.done;
  return events;
}

const shownTexts = (events: PanelAgentRunEvent[]) =>
  events.flatMap((event) => (event.kind === 'text' ? [event.text] : []));

describe('рабочие заметки модели не на языке разговора', () => {
  it('латиница перед вызовом действия в русском разговоре в ленту не идёт', async () => {
    const events = await run('выключи правило agentdeck-probe', [
      text('Need the rule id; list rules.'),
      tool('t1', 'list_rules'),
      toolResult('t1'),
      text('Правило выключено.'),
      end,
    ]);
    expect(shownTexts(events)).toEqual(['Правило выключено.']);
    expect(events.some((event) => event.kind === 'tool' && event.name === 'list_rules')).toBe(true);
  });

  it('латиница последним текстом хода — это ответ: он показан, а не потерян', async () => {
    const events = await run('что с правилами?', [
      text('Все правила включены, их два.'),
      text('All rules are enabled, there are two of them.'),
      end,
    ]);
    expect(shownTexts(events)).toEqual([
      'Все правила включены, их два.',
      'All rules are enabled, there are two of them.',
    ]);
  });

  it('в английском разговоре заметка перед действием остаётся', async () => {
    const events = await run('disable the probe rule', [
      text('Looking up the rule id first.'),
      tool('t1', 'list_rules'),
      toolResult('t1'),
      end,
    ]);
    expect(shownTexts(events)).toEqual(['Looking up the rule id first.']);
  });

  it('короткий идентификатор латиницей — не заметка', async () => {
    const events = await run('как зовут правило?', [
      text('p1-rule'),
      tool('t1', 'list_rules'),
      toolResult('t1'),
      text('Готово.'),
      end,
    ]);
    expect(shownTexts(events)).toEqual(['p1-rule', 'Готово.']);
  });
});

/**
 * F-269. Заметка, снятая с ленты перед вызовом, оставалась в запасе ответа: ответ
 * собирается из текстов хода — и она возвращалась в сохранённый ответ.
 */
describe('снятая заметка и ответ', () => {
  it('в ответ собирается только показанное', async () => {
    const events = await run('выключи правило agentdeck-probe', [
      text('Need the rule id; list rules.'),
      tool('t1', 'list_rules'),
      toolResult('t1'),
      text('Правило выключено.'),
      end,
    ]);
    const done = events.find((event) => event.kind === 'done');
    expect(done).toMatchObject({ kind: 'done', reply: 'Правило выключено.' });
  });
});
