import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@agentdeck/contracts';
import { lastTurnFacts, turnToolHint } from './turnToolHint';

const say = (role: ChatMessage['role'], blocks: ChatMessage['blocks']) => ({ role, blocks });
const CALL = '{"name":"Write","arguments":{"file_path":"a.txt"}}';

describe('lastTurnFacts', () => {
  it('считает вызовы и берёт последний текст хода после реплики человека', () => {
    const facts = lastTurnFacts([
      say('user', [{ type: 'text', text: 'старое' }]),
      say('assistant', [{ type: 'tool', name: 'Read', input: '{}' }]),
      say('user', [{ type: 'text', text: 'запиши файл' }]),
      say('assistant', [{ type: 'text', text: 'сейчас' }]),
      say('assistant', [{ type: 'text', text: CALL }]),
    ]);
    expect(facts).toEqual({ toolCalls: 0, text: CALL });
  });

  it('ответа после реплики человека нет — хода нет', () => {
    expect(lastTurnFacts([say('user', [{ type: 'text', text: 'привет' }])])).toBeUndefined();
  });
});

describe('turnToolHint', () => {
  const base = {
    routed: true,
    running: false,
    toolRoute: 'native' as const,
    toolCalls: 0,
    text: '',
  };

  it('вызов текстом при выключенной прослойке — «не исполнен»', () => {
    expect(turnToolHint({ ...base, text: CALL })).toBe('call-as-text');
  });

  it('с прослойкой вызов текстом не называется: исполняет она', () => {
    expect(turnToolHint({ ...base, toolRoute: 'shim', text: CALL })).toBe('no-tools');
  });

  it('ноль вызовов — «модель могла не справиться»', () => {
    expect(turnToolHint({ ...base, text: 'Готово' })).toBe('no-tools');
  });

  it('молчит: вызовы были, ход идёт, мимо контура, счёта нет', () => {
    expect(turnToolHint({ ...base, toolCalls: 2 })).toBeUndefined();
    expect(turnToolHint({ ...base, running: true })).toBeUndefined();
    expect(turnToolHint({ ...base, routed: false, text: CALL })).toBeUndefined();
    expect(turnToolHint({ ...base, toolCalls: undefined })).toBeUndefined();
  });
});
