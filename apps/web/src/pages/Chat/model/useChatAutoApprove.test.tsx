import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { agentRuns } from '@shared/lib/agent-runs';
import { useChatAutoApprove } from './useChatAutoApprove';

/**
 * Авторежим прав, вынесенный из `ChatPage`: выбор чата сильнее глобальной
 * настройки, без обоих — включён; щелчок пишет выбор на сервер И идущему прогону.
 * Запросы к серверу подменены — они ходят в сеть; стор прогонов настоящий (шпион).
 */

const state = vi.hoisted(() => ({
  data: undefined as { enabled: boolean; override?: boolean } | undefined,
  mutate: [] as unknown[],
  query: [] as unknown[][],
}));

vi.mock('@entities/ChatAutoMode', () => ({
  useChatAutoMode: (...args: unknown[]) => {
    state.query.push(args);
    return { data: state.data };
  },
  useSetChatAutoMode: () => ({ mutate: (input: unknown) => state.mutate.push(input) }),
}));

function use(chatId: string | undefined, globalDefault: boolean | undefined) {
  let result: ReturnType<typeof useChatAutoApprove> | undefined;
  function Probe() {
    result = useChatAutoApprove(chatId, 'session-1', globalDefault);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!result) throw new Error('hook did not run');
  return result;
}

beforeEach(() => {
  state.data = undefined;
  state.mutate = [];
  state.query = [];
  vi.restoreAllMocks();
});

describe('useChatAutoApprove', () => {
  it('выбор чата сильнее глобальной настройки; нет обоих — включён', () => {
    expect(use('c', undefined).autoApprove).toBe(true);
    expect(use('c', false).autoApprove).toBe(false);
    state.data = { enabled: true, override: true };
    const chosen = use('c', false);
    expect(chosen.autoApprove).toBe(true);
    expect(chosen.override).toBe(true);
    expect(state.query.at(-1)).toEqual(['c', 'session-1']);
  });

  it('щелчок пишет выбор на сервер и идущему прогону', () => {
    const spy = vi.spyOn(agentRuns, 'setAutoApprove').mockImplementation(() => {});
    use('c', true).toggle(false);
    expect(state.mutate).toEqual([{ chatId: 'c', enabled: false }]);
    expect(spy).toHaveBeenCalledWith('c', false);
  });

  it('без разговора щелчок ничего не делает', () => {
    const spy = vi.spyOn(agentRuns, 'setAutoApprove').mockImplementation(() => {});
    use(undefined, true).toggle(true);
    expect(state.mutate).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
