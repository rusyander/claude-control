import { describe, expect, it } from 'vitest';
import {
  EMPTY_CONVERSATION,
  applyRunEvent,
  fromConversation,
  withNotice,
  withTurnAborted,
  withUserMessage,
} from './conversation';

describe('conversation', () => {
  it('ход с блоками текста: ответ в ленте один раз, в истории из done', () => {
    let state = withUserMessage(EMPTY_CONVERSATION, 'создай проект');
    state = applyRunEvent(state, { kind: 'start', conversationId: 'c1', providerId: 'claude' });
    state = applyRunEvent(state, { kind: 'tool', name: 'create_project' });
    state = applyRunEvent(state, { kind: 'tool-result', name: 'create_project', isError: false });
    state = applyRunEvent(state, { kind: 'text', text: 'Готово' });
    state = applyRunEvent(state, { kind: 'done', reply: 'Готово' });
    expect(state.conversationId).toBe('c1');
    expect(state.running).toBe(false);
    expect(state.feed.map((item) => item.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(state.messages).toEqual([
      { role: 'user', content: 'создай проект' },
      { role: 'assistant', content: 'Готово' },
    ]);
  });

  it('done без блоков текста показывает ответ; ошибка действия видна', () => {
    let state = withUserMessage(EMPTY_CONVERSATION, 'x');
    state = applyRunEvent(state, { kind: 'tool-result', name: 'a', isError: true });
    state = applyRunEvent(state, { kind: 'done', reply: 'ответ' });
    expect(state.feed.map((item) => [item.kind, item.text])).toEqual([
      ['user', 'x'],
      ['tool-error', 'a'],
      ['assistant', 'ответ'],
    ]);
  });

  it('обрыв хода убирает последнюю реплику из истории, но не из ленты', () => {
    let state = withUserMessage(EMPTY_CONVERSATION, 'x');
    state = withTurnAborted(withNotice(state, 'error', 'отказ'));
    expect(state.running).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.feed.map((item) => item.kind)).toEqual(['user', 'error']);
  });

  it('ошибка хода останавливает ход', () => {
    const state = applyRunEvent(withUserMessage(EMPTY_CONVERSATION, 'x'), {
      kind: 'error',
      message: 'упал',
    });
    expect(state.running).toBe(false);
    expect(state.feed.at(-1)).toMatchObject({ kind: 'error', text: 'упал' });
  });

  it('разговор из истории продолжается тем же id', () => {
    const state = fromConversation({
      id: 'c9',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    } as never);
    expect(state.conversationId).toBe('c9');
    expect(state.feed.map((item) => item.kind)).toEqual(['user', 'assistant']);
    expect(state.messages).toHaveLength(2);
  });
});
