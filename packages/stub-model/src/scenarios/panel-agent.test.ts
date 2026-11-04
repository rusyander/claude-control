import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actionOf,
  decidePanelAgentStep,
  parsePanelAgentRequest,
  startPanelAgentModel,
  type PanelAgentModel,
  type PanelAgentProgram,
} from './panel-agent.mjs';

/**
 * Сценарий агента панели через ядро (P120): программа проверки переигрывается над историей
 * запроса — вызовы с результатом получают его, первый без результата уходит модели вызовом
 * моста, а инструмент, которого CLI ещё не предложил, сначала просится у `ToolSearch`.
 */

const MARK = '<!-- agentdeck:platform -->';
const BRIDGE = 'mcp__panel-bridge__save_rule';

/** Программа: одно правило, ответ — по результату действия. */
const program: PanelAgentProgram = async ({ current, tool }) => {
  if (current === 'empty') return { text: '' };
  const result = await tool('save_rule', { title: current });
  return result.isError ? `refused: ${result.text}` : `saved: ${result.text}`;
};

const anthropicBody = (history: unknown[] = []) => ({
  messages: [
    { role: 'user', content: [{ type: 'text', text: `${MARK}\nHuman (current request): rule A` }] },
    ...history,
  ],
});

const anthropicCall = (id: string, name: string, input: unknown) => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name, input }],
});
const anthropicResult = (id: string, text: string, isError = false) => ({
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError },
  ],
});

describe('сценарий агента панели: переигровка программы', () => {
  it('имя действия — только у инструментов моста', () => {
    expect(actionOf(BRIDGE)).toBe('save_rule');
    expect(actionOf('panel-bridge__list_rules')).toBe('list_rules');
    expect(actionOf('mcp__other__save_rule')).toBeUndefined();
    expect(actionOf('ToolSearch')).toBeUndefined();
  });

  it('инструмент не предложен — сначала загрузка через ToolSearch', async () => {
    const parsed = parsePanelAgentRequest(anthropicBody(), ['ToolSearch']);
    expect(parsed.current).toBe('rule A');
    expect(await decidePanelAgentStep(program, parsed)).toEqual({
      tool: { name: 'ToolSearch', args: { query: `select:${BRIDGE}`, max_results: 1 } },
    });
  });

  it('предложен — вызов моста с аргументами программы; загрузка в истории не мешает', async () => {
    const body = anthropicBody([
      anthropicCall('s1', 'ToolSearch', { query: `select:${BRIDGE}` }),
      anthropicResult('s1', 'loaded'),
    ]);
    const parsed = parsePanelAgentRequest(body, ['ToolSearch', BRIDGE]);
    expect(parsed.searches).toBe(1);
    expect(await decidePanelAgentStep(program, parsed)).toEqual({
      tool: { name: BRIDGE, args: { title: 'rule A' } },
    });
  });

  it('результат в истории — программа доходит до ответа текстом по нему', async () => {
    const ok = anthropicBody([anthropicCall('t1', BRIDGE, {}), anthropicResult('t1', 'Done.')]);
    expect(await decidePanelAgentStep(program, parsePanelAgentRequest(ok, [BRIDGE]))).toEqual({
      text: 'saved: Done.',
    });
    const refused = anthropicBody([
      anthropicCall('t1', BRIDGE, {}),
      anthropicResult('t1', 'Rejected', true),
    ]);
    expect(await decidePanelAgentStep(program, parsePanelAgentRequest(refused, [BRIDGE]))).toEqual({
      text: 'refused: Rejected',
    });
  });

  it('история расходится с программой — ошибка сценария, а не тихий другой ход', async () => {
    const body = anthropicBody([
      anthropicCall('t1', 'mcp__panel-bridge__list_rules', {}),
      anthropicResult('t1', '{}'),
    ]);
    await expect(
      decidePanelAgentStep(program, parsePanelAgentRequest(body, [BRIDGE])),
    ).rejects.toThrow(/call 1 is list_rules, program asked save_rule/);
  });

  it('загрузчика нет или он исчерпан — честный текст вместо бесконечного цикла', async () => {
    const step = await decidePanelAgentStep(program, parsePanelAgentRequest(anthropicBody(), []));
    expect(step).toEqual({ text: expect.stringContaining(`${BRIDGE} is not offered`) });
    // Загрузчик есть, но двенадцать загрузок уже в истории, а инструмента всё нет — тоже текст.
    const searches = Array.from({ length: 12 }, (_, index) => [
      anthropicCall(`s${index}`, 'ToolSearch', { query: `select:${BRIDGE}` }),
      anthropicResult(`s${index}`, 'no match'),
    ]).flat();
    const exhausted = parsePanelAgentRequest(anthropicBody(searches), ['ToolSearch']);
    expect(exhausted.searches).toBe(12);
    expect(await decidePanelAgentStep(program, exhausted)).toEqual({
      text: expect.stringContaining(`${BRIDGE} is not offered`),
    });
  });

  it('реплика перед вызовом — тем же ответом, что вызов; загрузка через ToolSearch — без неё', async () => {
    const talking: PanelAgentProgram = async ({ tool }) => {
      const result = await tool('save_rule', { title: 'x' }, { say: 'Готовлю правило.' });
      return result.text;
    };
    expect(
      await decidePanelAgentStep(talking, parsePanelAgentRequest(anthropicBody(), [BRIDGE])),
    ).toEqual({ text: 'Готовлю правило.', tool: { name: BRIDGE, args: { title: 'x' } } });
    expect(
      await decidePanelAgentStep(talking, parsePanelAgentRequest(anthropicBody(), ['ToolSearch'])),
    ).toEqual({
      tool: { name: 'ToolSearch', args: { query: `select:${BRIDGE}`, max_results: 1 } },
    });
  });

  it('запрос без метки платформы — служебный, ответ «ok»', async () => {
    const parsed = parsePanelAgentRequest({ messages: [{ role: 'user', content: 'title?' }] }, []);
    expect(parsed.prompt).toBeUndefined();
    expect(await decidePanelAgentStep(program, parsed)).toEqual({ text: 'ok' });
  });

  it('OpenAI chat: вызовы tool_calls и реплики tool читаются так же', async () => {
    const body = {
      messages: [
        { role: 'user', content: `${MARK}\nrule B` },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              function: { name: 'panel-bridge__save_rule', arguments: '{"title":"rule B"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'Done.' },
      ],
    };
    const parsed = parsePanelAgentRequest(body, ['panel-bridge__save_rule']);
    expect(parsed.calls).toEqual([
      { name: 'save_rule', args: { title: 'rule B' }, text: 'Done.', isError: false },
    ]);
    expect(await decidePanelAgentStep(program, parsed)).toEqual({ text: 'saved: Done.' });
  });
});

describe('сценарий агента панели: сервер пакета', () => {
  let model: PanelAgentModel;
  beforeAll(async () => {
    model = await startPanelAgentModel(program);
  });
  afterAll(async () => {
    await model.close();
  });

  it('вызов моста уходит событием tool_use диалекта, ход записывается в turns', async () => {
    const res = await fetch(`${model.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({
        model: 'stub-model',
        max_tokens: 100,
        tools: [{ name: BRIDGE, input_schema: { type: 'object' } }],
        ...anthropicBody(),
      }),
    });
    const json = (await res.json()) as {
      content: { type: string; name?: string; input?: unknown }[];
    };
    expect(json.content).toContainEqual(
      expect.objectContaining({ type: 'tool_use', name: BRIDGE, input: { title: 'rule A' } }),
    );
    expect(model.turns.at(-1)?.current).toBe('rule A');
  });
});
