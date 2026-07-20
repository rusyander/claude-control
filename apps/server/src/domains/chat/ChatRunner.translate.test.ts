import { describe, it, expect } from 'vitest';
import { translate, type ChatEvent } from './ChatRunner.ts';

/**
 * Разбор потока Claude Code в события интерфейса (чистая функция `translate`).
 * Настоящий CLI в тестах не поднять, поэтому подаём «сырые» строки потока как
 * есть и проверяем перевод: init-сессия, потоковые дельты текста/размышления,
 * вызовы инструментов, лимиты, финал (done/ошибка). Позитив + негатив + край.
 *
 * translate возвращает МАССИВ событий (одному сообщению ассистента может
 * отвечать несколько вызовов инструментов). В тестах кладём структурно
 * совместимые объекты через приведение к типу первого параметра.
 */
type Raw = Parameters<typeof translate>[0];
const raw = (value: unknown): Raw => value as Raw;

describe('translate — разбор потока CLI', () => {
  it('system/init → session с моделью и числом инструментов', () => {
    const events = translate(
      raw({ type: 'system', subtype: 'init', session_id: 's1', model: 'opus', tools: [1, 2, 3] }),
    );
    expect(events).toEqual([{ kind: 'session', sessionId: 's1', model: 'opus', tools: 3 }]);
  });

  it('system/init без полей → пустые значения по умолчанию', () => {
    const events = translate(raw({ type: 'system', subtype: 'init' }));
    expect(events).toEqual([{ kind: 'session', sessionId: '', model: '', tools: 0 }]);
  });

  it('потоковая дельта текста → text', () => {
    const events = translate(
      raw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'при' } },
      }),
    );
    expect(events).toEqual([{ kind: 'text', text: 'при' }]);
  });

  it('потоковая дельта размышления → thinking', () => {
    const events = translate(
      raw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'хм' } },
      }),
    );
    expect(events).toEqual([{ kind: 'thinking', text: 'хм' }]);
  });

  it('пустая текстовая дельта не рождает события (край: text отсутствует)', () => {
    // delta.text пустой → нечего показывать, событий нет.
    const events = translate(
      raw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
      }),
    );
    expect(events).toEqual([]);
  });

  it('дельта ввода инструмента (input_json_delta) игнорируется', () => {
    const events = translate(
      raw({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', text: '{' } },
      }),
    );
    expect(events).toEqual([]);
  });

  it('assistant с tool_use → tool с именем, вводом и id', () => {
    const events = translate(
      raw({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'tu1' }],
        },
      }),
    );
    expect(events).toEqual([{ kind: 'tool', name: 'Bash', input: { command: 'ls' }, id: 'tu1' }]);
  });

  it('assistant без tool_use (только текст) → пусто (текст идёт дельтами)', () => {
    const events = translate(
      raw({ type: 'assistant', message: { content: [{ type: 'text', text: 'готово' }] } }),
    );
    expect(events).toEqual([]);
  });

  it('rate_limit_event → limit c моментом сброса и типом', () => {
    const events = translate(
      raw({
        type: 'rate_limit_event',
        rate_limit_info: { resetsAt: 123, rateLimitType: 'tokens', status: 'active' },
      }),
    );
    expect(events).toEqual([{ kind: 'limit', resetsAt: 123, type: 'tokens', status: 'active' }]);
  });

  it('result без ошибки → done со стоимостью, длительностью и сессией', () => {
    const events = translate(
      raw({ type: 'result', total_cost_usd: 0.42, duration_ms: 1500, session_id: 's9' }),
    );
    expect(events).toEqual([{ kind: 'done', costUsd: 0.42, durationMs: 1500, sessionId: 's9' }]);
  });

  it('result с ошибкой → error с текстом результата', () => {
    const events = translate(raw({ type: 'result', is_error: true, result: 'лимит исчерпан' }));
    expect(events).toEqual([{ kind: 'error', message: 'лимит исчерпан' }]);
  });

  it('result-ошибка без текста → дефолтное сообщение', () => {
    const events = translate(raw({ type: 'result', is_error: true }));
    expect(events).toEqual([{ kind: 'error', message: 'Запрос не выполнен' }]);
  });

  it('незнакомый тип события → пусто (шум CLI отбрасывается)', () => {
    expect(translate(raw({ type: 'system', subtype: 'other' }))).toEqual([]);
    expect(translate(raw({ type: 'user' }))).toEqual([]);
    expect(translate(raw({ type: 'unknown' }))).toEqual([]);
  });

  it('единственный tool_use возвращается одним элементом массива', () => {
    const events = translate(
      raw({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'сначала текст' },
            { type: 'tool_use', name: 'Read', input: {}, id: 'r1' },
          ],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect((events[0] as Extract<ChatEvent, { kind: 'tool' }>).name).toBe('Read');
  });
});

/**
 * Регресс к находке B1: при нескольких tool_use в одном сообщении ассистента
 * translate обязан вернуть событие по КАЖДОМУ, а не только по первому. Особенно
 * важно, когда среди них AskUserQuestion, — иначе жёлтая точка «агент ждёт
 * ответа» не зажжётся (см. .agent/tmp/audit-chat.md, находка B1).
 */
describe('translate — несколько инструментов в одном сообщении (регресс B1)', () => {
  it('возвращает события по КАЖДОМУ tool_use, а не только по первому', () => {
    const events = translate(
      raw({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { path: 'a.ts' }, id: 'r1' },
            { type: 'tool_use', name: 'AskUserQuestion', input: { q: '?' }, id: 'q1' },
          ],
        },
      }),
    );

    expect(events).toEqual([
      { kind: 'tool', name: 'Read', input: { path: 'a.ts' }, id: 'r1' },
      { kind: 'tool', name: 'AskUserQuestion', input: { q: '?' }, id: 'q1' },
    ]);
    // AskUserQuestion не потерялся — точка «ждёт ответа» получит свой сигнал.
    const names = events.map((event) => (event as Extract<ChatEvent, { kind: 'tool' }>).name);
    expect(names).toContain('AskUserQuestion');
  });

  it('текст между инструментами не мешает — берутся оба tool_use', () => {
    const events = translate(
      raw({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: {}, id: 'r1' },
            { type: 'text', text: 'а теперь спрошу' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'b1' },
          ],
        },
      }),
    );
    expect(events.map((event) => (event as Extract<ChatEvent, { kind: 'tool' }>).name)).toEqual([
      'Read',
      'Bash',
    ]);
  });
});
