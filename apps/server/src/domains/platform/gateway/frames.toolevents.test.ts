import { describe, it, expect } from 'vitest';
import { enterprisePlatformDriver } from '../drivers/enterprise-platform.ts';
import { StreamTranslator, toolRefusalText } from './frames.ts';

/**
 * ПРИДЕРЖАННЫЙ ВЫЗОВ: шов между синхронным переводом кадров и хуком-процессом
 * (П4.1).
 *
 * Здесь проверяется ровно то, чего не видит проверка настоящим путём: ПОРЯДОК.
 * `check-tool-shim-hooks.mjs` доказывает, что запрещённый вызов не доезжает до
 * клиента и файла на диске нет, — но она смотрит на исход, а не на то, что
 * уехало клиенту раньше чего. А вся конструкция держится именно на порядке:
 * текст, обогнавший ждущий вызов, переворачивает ответ местами, а `[DONE]`,
 * уехавший до решения, делает отказ невидимым — клиент после него читать
 * перестаёт.
 */

function sse(...frames: string[]): string {
  return frames.map((frame) => `data: ${frame}\n\n`).join('');
}

const say = (text: string): string =>
  `{"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}}}]}`;

const CALL = '<tool_call>{"name":"Write","arguments":{"file_path":"a.ts"}}</tool_call>';

function withGate(dialect: 'openai-compat' | 'anthropic' = 'openai-compat'): StreamTranslator {
  return new StreamTranslator({
    driver: enterprisePlatformDriver,
    dialect,
    model: 'gpt-x',
    includeUsage: false,
    shim: { allowed: new Set(['Write']), toolEvents: true },
  });
}

describe('вызов, ждущий решения события инструмента', () => {
  it('без ворот вызов уезжает сразу — прежнее поведение прослойки', () => {
    const translator = new StreamTranslator({
      driver: enterprisePlatformDriver,
      dialect: 'openai-compat',
      model: 'gpt-x',
      includeUsage: false,
      shim: { allowed: new Set(['Write']) },
    });
    const out = translator.push(sse(say(CALL), '[DONE]'));

    expect(out).toContain('tool_calls');
    expect(translator.pendingToolCalls()).toHaveLength(0);
  });

  it('вызов не уезжает клиенту до решения, и ответ не закрывается без него', () => {
    const translator = withGate();
    const out = translator.push(sse(say(CALL), '[DONE]'));

    expect(out).not.toContain('tool_calls');
    // `[DONE]` придержан вместе с вызовом: клиент, прочитавший его, перестал бы
    // читать, и решение — что бы оно ни было — уехало бы в никуда.
    expect(out).not.toContain('[DONE]');
    expect(translator.pendingToolCalls()).toHaveLength(1);
    expect(translator.pendingToolCalls()[0]?.call.name).toBe('Write');
  });

  it('разрешение отдаёт вызов и только после него закрывает ответ', () => {
    const translator = withGate();
    translator.push(sse(say(CALL), '[DONE]'));
    const id = translator.pendingToolCalls()[0]?.call.id ?? '';
    const out = translator.resolveToolCall(id, { allow: true });

    expect(out).toContain('tool_calls');
    expect(out.indexOf('tool_calls')).toBeLessThan(out.indexOf('[DONE]'));
    expect(translator.facts.toolCalls).toBe(1);
    expect(translator.facts.toolsBlocked).toEqual([]);
    expect(translator.pendingToolCalls()).toHaveLength(0);
  });

  it('отказ ставит на место вызова результат инструмента, а не обрыв', () => {
    const translator = withGate();
    translator.push(sse(say(CALL), '[DONE]'));
    const id = translator.pendingToolCalls()[0]?.call.id ?? '';
    const out = translator.resolveToolCall(id, { allow: false, reason: 'сюда писать нельзя' });

    expect(out).not.toContain('tool_calls');
    expect(out).toContain('tool_result');
    expect(out).toContain('сюда писать нельзя');
    expect(out).toContain('[DONE]');
    // Вызовом это не считается ни в одном счётчике: клиент его не видел, и
    // «вызовов был один» в следе означало бы состоявшееся действие.
    expect(translator.facts.toolCalls).toBe(0);
    expect(translator.facts.toolsBlocked).toEqual(['Write']);
    // Отказ лежит и в тексте ответа: цельное тело собирается из него, и клиент,
    // просивший не поток, обязан прочитать ту же причину.
    expect(translator.assembled().text).toContain('сюда писать нельзя');
    expect(translator.assembled().calls).toHaveLength(0);
  });

  it('текст, приехавший ЗА ждущим вызовом, не обгоняет его', () => {
    const translator = withGate();
    // Один кадр, в нём вызов и текст после него: разборщик отдаёт оба события
    // разом, и без очереди текст уехал бы вперёд вызова.
    const held = translator.push(sse(say(`${CALL}и вот что дальше`)));

    expect(held).not.toContain('и вот что дальше');
    const id = translator.pendingToolCalls()[0]?.call.id ?? '';
    const out = translator.resolveToolCall(id, { allow: true });
    expect(out.indexOf('tool_calls')).toBeLessThan(out.indexOf('и вот что дальше'));
  });

  it('второй вызов ждёт СВОЕГО решения, а не уезжает с первым', () => {
    const translator = withGate();
    translator.push(sse(say(`${CALL}${CALL}`), '[DONE]'));
    expect(translator.pendingToolCalls()).toHaveLength(1);

    const first = translator.pendingToolCalls()[0]?.call.id ?? '';
    const out = translator.resolveToolCall(first, { allow: true });
    // Ответ ещё не закрыт: второй вызов вынут из очереди и ждёт своего хука.
    expect(out).not.toContain('[DONE]');
    expect(translator.pendingToolCalls()).toHaveLength(1);
    expect(translator.pendingToolCalls()[0]?.call.id).not.toBe(first);

    const second = translator.pendingToolCalls()[0]?.call.id ?? '';
    const tail = translator.resolveToolCall(second, { allow: false, reason: 'второй нельзя' });
    expect(tail).toContain('второй нельзя');
    expect(tail).toContain('[DONE]');
    expect(translator.facts.toolsBlocked).toEqual(['Write']);
    expect(translator.facts.toolCalls).toBe(1);
  });

  it('в диалекте Anthropic закрытие ждёт решения, а начало сообщения — нет', () => {
    const translator = withGate('anthropic');
    const held = translator.push(sse(say(CALL), '[DONE]'));

    // `message_start` обязан уехать раньше любого содержимого — и уезжает, иначе
    // клиент Anthropic считает ответ испорченным.
    expect(held).toContain('message_start');
    expect(held).not.toContain('message_stop');
    const id = translator.pendingToolCalls()[0]?.call.id ?? '';
    const out = translator.resolveToolCall(id, { allow: true });
    expect(out).toContain('tool_use');
    expect(out.indexOf('tool_use')).toBeLessThan(out.indexOf('message_stop'));
  });

  it('обрыв связи ждущий вызов не синтезирует, а текст за ним отдаёт', () => {
    const translator = withGate();
    translator.push(sse(say(`${CALL}сказанное до обрыва`)));
    expect(translator.pendingToolCalls()).toHaveLength(1);

    const out = translator.fail('связь с контуром оборвалась');
    expect(out).toContain('сказанное до обрыва');
    expect(out).not.toContain('tool_calls');
    expect(out.indexOf('сказанное до обрыва')).toBeLessThan(out.indexOf('связь с контуром'));
    expect(translator.pendingToolCalls()).toHaveLength(0);
    expect(translator.facts.toolCalls).toBe(0);
    expect(translator.facts.truncated).toBe(true);
  });

  it('вызов, оставленный без решения, пропускается, а не теряется', () => {
    const translator = withGate();
    translator.push(sse(say(CALL), '[DONE]'));
    const out = translator.flushPendingToolCalls();

    expect(out).toContain('tool_calls');
    expect(out).toContain('[DONE]');
    expect(translator.facts.toolCalls).toBe(1);
  });

  it('цитата протокола в блоке кода не придерживается и не запрещается', () => {
    // Ворота включены, но вызова здесь нет — есть текст о вызове. Придержать его
    // значило бы остановить ответ на куске документации, а «запретить» — показать
    // человеку отказ по правилу, которое никто не нарушал.
    const translator = withGate();
    const quoted = `Протокол выглядит так:\n\n\`\`\`\n${CALL}\n\`\`\`\n\nЭто только пример.`;
    const out = translator.push(sse(say(quoted), '[DONE]'));

    expect(translator.pendingToolCalls()).toHaveLength(0);
    expect(out).toContain('Это только пример.');
    // Ответ закрыт сразу: ждать решения не о чем.
    expect(out).toContain('[DONE]');
    expect(translator.facts.toolCalls).toBe(0);
    expect(translator.facts.toolsBlocked).toEqual([]);
    expect(translator.assembled().text).toContain('<tool_call>');
  });

  it('пометка «описала и не вызвала» не загорается на ждущем вызове', () => {
    const translator = withGate();
    translator.push(sse(say(`Сейчас создам файл.\n${CALL}`), '[DONE]'));

    expect(translator.pendingToolCalls()).toHaveLength(1);
    expect(translator.facts.claimedWithoutCall).toBe(false);
  });
});

/**
 * Текст отказа — в грамматике самого протокола: модель читает его там же, где
 * ждала результат. Написанный своими словами, он стал бы для неё обычным текстом
 * ответа, и она повторила бы вызов, считая, что его не заметили.
 */
describe('текст отказа', () => {
  it('это результат инструмента с его именем', () => {
    expect(toolRefusalText('Write', 'нельзя')).toBe(
      '<tool_result name="Write">Вызов «Write» остановлен хуком PreToolUse: нельзя</tool_result>',
    );
  });

  it('без причины отказ всё равно назван — молчания здесь быть не может', () => {
    const text = toolRefusalText('Bash');
    expect(text).toContain('<tool_result name="Bash">');
    expect(text).toContain('PreToolUse');
    expect(text).not.toContain('undefined');
  });
});
