import { describe, it, expect } from 'vitest';
import { NativeThinkFilter, withoutThinkMessage } from './native-think.ts';

const frame = (type: string, data: Record<string, unknown> = {}): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const text = (value: string, index = 0): string =>
  frame('content_block_delta', { index, delta: { type: 'text_delta', text: value } });

function texts(stream: string): string {
  return stream
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)) as { delta?: { type?: string; text?: string } })
    .map((event) => (event.delta?.type === 'text_delta' ? (event.delta.text ?? '') : ''))
    .join('');
}

describe('NativeThinkFilter', () => {
  it('ping посреди размышления не выпускает черновик клиенту', () => {
    const filter = new NativeThinkFilter('tail');
    let out = filter.push(text('прикидываю'));
    out += filter.push(frame('ping'));
    expect(texts(out)).toBe('');
    out += filter.push(text('</think>ответ'));
    out += filter.push(frame('content_block_stop', { index: 0 }));
    expect(texts(out)).toBe('ответ');
    expect(filter.reasoningChars).toBe('прикидываю'.length);
  });

  it('незакрытое размышление отдаётся текстом ПЕРЕД content_block_stop', () => {
    const filter = new NativeThinkFilter('tail');
    const out =
      filter.push(text('просто ответ')) + filter.push(frame('content_block_stop', { index: 0 }));
    expect(texts(out)).toBe('просто ответ');
    expect(out.indexOf('просто ответ')).toBeLessThan(out.indexOf('content_block_stop'));
  });

  it('кадр, разрезанный кусками сети, собирается; второй текстовый блок идёт как есть', () => {
    const filter = new NativeThinkFilter('lead');
    const whole =
      text('<think>x</think>да') + frame('content_block_stop', { index: 0 }) + text('<think>', 2);
    const out = filter.push(whole.slice(0, 17)) + filter.push(whole.slice(17)) + filter.end();
    expect(texts(out)).toBe('да<think>');
  });

  it('цельное сообщение: первый текстовый блок без размышления, тело не мутируется', () => {
    const payload = { type: 'message', content: [{ type: 'text', text: 'мысль</think>\nответ' }] };
    const split = withoutThinkMessage(payload, 'tail');
    expect(split.payload).toEqual({ type: 'message', content: [{ type: 'text', text: 'ответ' }] });
    expect(payload.content[0]?.text).toBe('мысль</think>\nответ');
  });
});
