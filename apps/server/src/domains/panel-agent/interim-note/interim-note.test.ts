import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn as nodeSpawn } from 'node:child_process';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import { startPanelAgentRun } from '../runner/runner.ts';

/**
 * Живой прогон 26.09: в русском разговоре лента показывала «Need the rule id;
 * list rules.» и «Look at the target first.» — строка промпта про язык держала
 * лишь часть ходов. Проверка идёт через сам ход (`startPanelAgentRun`) на
 * подменённом процессе: поток событий CLI тот же, что пишет `claude -p`.
 */
function fakeCli(lines: object[]): typeof nodeSpawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      pid: number;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 424242;
    child.kill = () => true;
    setImmediate(() => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`);
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }) as unknown as typeof nodeSpawn;
}

const text = (value: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text: value }] },
});
const tool = (id: string, name: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: `mcp__agentdeck-panel__${name}` }] },
});
const toolResult = (id: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const result = (value: string) => ({ type: 'result', result: value, is_error: false });

async function run(userText: string, lines: object[]): Promise<PanelAgentRunEvent[]> {
  const events: PanelAgentRunEvent[] = [];
  const handle = startPanelAgentRun({
    command: 'node',
    env: {},
    selfBaseUrl: 'http://127.0.0.1:1',
    conversationId: 'c1',
    context: { route: '/rules', title: 'Правила' },
    messages: [{ role: 'user', content: userText }],
    onEvent: (event) => events.push(event),
    spawnImpl: fakeCli(lines),
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
      result('Правило выключено.'),
    ]);
    expect(shownTexts(events)).toEqual(['Правило выключено.']);
    expect(events.some((event) => event.kind === 'tool' && event.name === 'list_rules')).toBe(true);
  });

  it('латиница последним текстом хода — это ответ: он показан, а не потерян', async () => {
    const events = await run('что с правилами?', [
      text('Все правила включены, их два.'),
      text('All rules are enabled, there are two of them.'),
      result('All rules are enabled, there are two of them.'),
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
      result('Done.'),
    ]);
    expect(shownTexts(events)).toEqual(['Looking up the rule id first.']);
  });

  it('короткий идентификатор латиницей — не заметка', async () => {
    const events = await run('как зовут правило?', [
      text('p1-rule'),
      tool('t1', 'list_rules'),
      toolResult('t1'),
      result('Готово.'),
    ]);
    expect(shownTexts(events)).toEqual(['p1-rule']);
  });
});

/**
 * F-269. Заметка, снятая с ленты перед вызовом, оставалась в запасе ответа: без
 * текста итога CLI ответ собирается из текстов хода — и она возвращалась в
 * сохранённый ответ.
 */
describe('снятая заметка и ответ без итога CLI', () => {
  it('в ответ собирается только показанное', async () => {
    const events = await run('выключи правило agentdeck-probe', [
      text('Need the rule id; list rules.'),
      tool('t1', 'list_rules'),
      toolResult('t1'),
      text('Правило выключено.'),
      { type: 'result', result: '', is_error: false },
    ]);
    const done = events.find((event) => event.kind === 'done');
    expect(done).toMatchObject({ kind: 'done', reply: 'Правило выключено.' });
  });
});
