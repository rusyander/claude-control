import type { PanelAgentConversation } from '@agentdeck/contracts/panel-agent';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_CONVERSATION,
  applyRunEvent,
  fromConversation,
  isOwnConversationEvent,
  pendingOpensWindow,
  reloadSettledConversation,
  splitPending,
  withNotice,
  withTurnAborted,
  withReloadedConversation,
  withSealedTurnCaughtUp,
  withUserMessage,
} from './conversation';
import { sealFooter, sealNoteFrom } from '@agentdeck/contracts/panel-agent-feed';

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

  it('упавший ход не уезжает контекстом в следующий: одна реплика человека в конце истории', () => {
    let state = withUserMessage(EMPTY_CONVERSATION, 'удали правило');
    state = applyRunEvent(state, { kind: 'error', message: 'потолок хода' });
    state = withUserMessage(state, 'покажи хуки');
    expect(state.messages).toEqual([{ role: 'user', content: 'покажи хуки' }]);
    expect(state.feed.map((item) => item.text)).toEqual([
      'удали правило',
      'потолок хода',
      'покажи хуки',
    ]);
  });

  it('разговор из истории, оборванный на реплике человека, продолжается без неё', () => {
    const state = fromConversation({
      id: 'c9',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'упавшая просьба' },
      ],
    } as never);
    expect(state.feed.map((item) => item.text)).toEqual(['a', 'b', 'упавшая просьба']);
    expect(state.messages.map((message) => message.content)).toEqual(['a', 'b']);
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

  it('переход и итог карточки — только своему разговору; событие без разговора общее', () => {
    const mine = { conversationId: 'c1' };
    expect(isOwnConversationEvent('c1', mine)).toBe(true);
    expect(isOwnConversationEvent('c2', mine)).toBe(false);
    expect(isOwnConversationEvent('c2', EMPTY_CONVERSATION)).toBe(false);
    expect(isOwnConversationEvent(undefined, mine)).toBe(true);
  });

  it('ждущие карточки делятся на свои и чужие: чужие не смешиваются с разговором', () => {
    const mine = { ...EMPTY_CONVERSATION, conversationId: 'c1' };
    const cards = [
      { id: 'a', conversationId: 'c1' },
      { id: 'b', conversationId: 'c2' },
      { id: 'c' },
    ];
    const split = splitPending(cards, (id) => isOwnConversationEvent(id, mine));
    expect(split.own.map((card) => card.id)).toEqual(['a', 'c']);
    expect(split.foreign.map((card) => card.id)).toEqual(['b']);
    // Новый разговор ещё без id: карточка любого разговора ему чужая.
    const fresh = splitPending(cards, (id) => isOwnConversationEvent(id, EMPTY_CONVERSATION));
    expect(fresh.foreign.map((card) => card.id)).toEqual(['a', 'b']);
  });

  it('[C1] окно открывает только карточка своего разговора; чужая — лишь значок', () => {
    const mine = { ...EMPTY_CONVERSATION, conversationId: 'c1' };
    const isMine = (id: string | undefined) => isOwnConversationEvent(id, mine);
    expect(pendingOpensWindow({ conversationId: 'c1' }, isMine)).toBe(true);
    expect(pendingOpensWindow({ conversationId: 'c2' }, isMine)).toBe(false);
    // Вкладка без разговора (окно ни разу не писало): карточка любого разговора чужая.
    const fresh = (id: string | undefined) => isOwnConversationEvent(id, EMPTY_CONVERSATION);
    expect(pendingOpensWindow({ conversationId: 'c2' }, fresh)).toBe(false);
    // Карточка без разговора общая, как и прочие события без id: окно открывается.
    expect(pendingOpensWindow({}, fresh)).toBe(true);
  });

  describe('[F-50] запечатанный ответ: модели — английский хвост, человеку — пометка его языком', () => {
    const at = '2026-09-26T00:00:00.000Z';
    const seal = { reason: 'restart' as const, actions: ['toggle_rule', 'where_am_i (failed)'] };
    const content = `Выключаю.\n\n${sealFooter(seal)}`;
    const conversation: PanelAgentConversation = {
      id: 'c1',
      createdAt: at,
      updatedAt: at,
      context: { route: '/rules' },
      messages: [
        { role: 'user', content: 'выключи правило', at },
        { role: 'assistant', content, at, interrupted: true, seal },
      ],
    };
    const note = sealNoteFrom({
      actions: (list) => `Выполненные действия: ${list}.`,
      failed: (name) => `${name} (ошибка)`,
      notFinished: (reason) => `Ответ не дописан. ${reason}`,
      reason: {
        restart: 'Панель перезапустилась посреди хода.',
        stopped: 'Ход остановлен.',
        timeout: 'Время вышло.',
        failed: 'Ход оборвался.',
      },
    });

    it('лента — пометкой окна, история — как в файле', () => {
      const state = fromConversation(conversation, note);
      expect(state.feed[1]?.text).toBe(
        'Выключаю.\n\nВыполненные действия: toggle_rule, where_am_i (ошибка).\n\nОтвет не дописан. Панель перезапустилась посреди хода.',
      );
      expect(state.messages[1]?.content).toBe(content);
      expect(content).not.toContain('Ответ не дописан');
    });

    it('хвост не узнан (старый русский файл) — реплика как есть', () => {
      const legacy = {
        ...conversation,
        messages: [{ ...conversation.messages[1]!, content: 'Ответ не дописан. Старое.' }],
      };
      expect(fromConversation(legacy, note).feed[0]?.text).toBe('Ответ не дописан. Старое.');
    });

    it('догнавший запечатанный ход — тоже пометкой окна', () => {
      const local = { ...EMPTY_CONVERSATION, conversationId: 'c1' };
      const next = withSealedTurnCaughtUp(local, conversation, 'notice', 'перечитано', note);
      expect(next?.feed[1]?.text).toContain('Ответ не дописан. Панель перезапустилась');
    });
  });

  describe('[F-66] перечитанный разговор ложится, только если экран на нём', () => {
    const at = '2026-09-26T00:00:00.000Z';
    const old: PanelAgentConversation = {
      id: 'old',
      createdAt: at,
      updatedAt: at,
      context: { route: '/' },
      messages: [{ role: 'user', content: 'старый вопрос', at }],
    };

    it('экран на том же разговоре — лента из файла и заметка', () => {
      const next = withReloadedConversation({ conversationId: 'old' }, old, 'error', 'обрыв');
      expect(next?.conversationId).toBe('old');
      expect(next?.feed.at(-1)).toMatchObject({ kind: 'error', text: 'обрыв' });
    });

    it('пока ждали — «Новый разговор» или другой из истории: ленту не трогаем', () => {
      expect(withReloadedConversation(EMPTY_CONVERSATION, old, 'error', 'обрыв')).toBeUndefined();
      expect(
        withReloadedConversation({ conversationId: 'new' }, old, 'error', 'обрыв'),
      ).toBeUndefined();
    });
  });

  describe('[Z5-3/Z5-4] перечитать разговор после обрыва', () => {
    const at = '2026-09-26T00:00:00.000Z';
    const asked = { role: 'user' as const, content: 'сколько правил?', at };
    const sealed = { role: 'assistant' as const, content: 'Ответ не дописан.', at };
    const conversation = (
      messages: PanelAgentConversation['messages'],
    ): PanelAgentConversation => ({
      id: 'c1',
      createdAt: at,
      updatedAt: at,
      context: { route: '/rules' },
      messages,
    });
    /** Ответы сервера по очереди, последний повторяется: Error = панель ещё поднимается. */
    const server = (...replies: (PanelAgentConversation | Error)[]) => {
      let calls = 0;
      const fetch = async (): Promise<PanelAgentConversation> => {
        const reply = replies.at(Math.min(calls, replies.length - 1));
        calls += 1;
        if (!reply || reply instanceof Error) throw reply ?? new Error('no reply');
        return reply;
      };
      return { fetch, calls: () => calls };
    };
    let waits = 0;
    const wait = async () => {
      waits += 1;
    };

    it('панель ещё поднимается: ошибка чтения, затем разговор', async () => {
      waits = 0;
      const s = server(new Error('ECONNREFUSED'), conversation([asked, sealed]));
      const got = await reloadSettledConversation(s.fetch, { wait });
      expect(got?.messages.at(-1)).toEqual(sealed);
      expect(s.calls()).toBe(2);
      expect(waits).toBe(1);
    });

    it('ход ещё не запечатан: ждёт и берёт запечатанный', async () => {
      waits = 0;
      const s = server(conversation([asked]), conversation([asked, sealed]));
      const got = await reloadSettledConversation(s.fetch, { wait });
      expect(got?.messages.at(-1)).toEqual(sealed);
      expect(s.calls()).toBe(2);
    });

    it('ход без сказанного так и не запечатан: одно ожидание, затем что есть', async () => {
      waits = 0;
      const s = server(conversation([asked]));
      const got = await reloadSettledConversation(s.fetch, { wait });
      expect(got?.messages.at(-1)).toEqual(asked);
      expect(s.calls()).toBe(2);
      expect(waits).toBe(1);
    });

    it('сервер так и не ответил: undefined после всех попыток, без лишней паузы в конце', async () => {
      waits = 0;
      const s = server(new Error('down'));
      expect(await reloadSettledConversation(s.fetch, { attempts: 3, wait })).toBeUndefined();
      expect(s.calls()).toBe(3);
      expect(waits).toBe(2);
    });

    it('отставшая вкладка: одна попытка, незапечатанный ход не ждёт', async () => {
      waits = 0;
      const s = server(conversation([asked]), conversation([asked, sealed]));
      const got = await reloadSettledConversation(s.fetch, { attempts: 1, wait });
      expect(got?.messages.at(-1)).toEqual(asked);
      expect(s.calls()).toBe(1);
      expect(waits).toBe(0);
    });
  });

  describe('[Z5-2] остановленный ход, запечатанный сервером', () => {
    const at = '2026-09-26T00:00:00.000Z';
    const said = { role: 'assistant' as const, content: 'Ответ не дописан. Успел: правил 3.', at };
    const file = (messages: PanelAgentConversation['messages']): PanelAgentConversation => ({
      id: 'c1',
      createdAt: at,
      updatedAt: at,
      context: { route: '/rules' },
      messages,
    });
    // Окно после Stop: пара сброшена, строка об остановке в ленте.
    const stopped = () => {
      let state = withUserMessage(EMPTY_CONVERSATION, 'сколько правил?');
      state = applyRunEvent(state, { kind: 'start', conversationId: 'c1', providerId: 'claude' });
      state = applyRunEvent(state, { kind: 'text', text: 'Правил 3' });
      return withNotice(withTurnAborted(state), 'notice', 'Остановлено');
    };
    const asked = { role: 'user' as const, content: 'сколько правил?', at };

    it('файл длиннее ленты — лента берёт запечатанный ответ и ту же строку итога', () => {
      const next = withSealedTurnCaughtUp(stopped(), file([asked, said]), 'notice', 'Остановлено');
      expect(next?.messages).toEqual([
        { role: 'user', content: 'сколько правил?' },
        { role: 'assistant', content: said.content },
      ]);
      expect(next?.feed.map((item) => item.kind)).toEqual(['user', 'assistant', 'notice']);
      expect(next?.feed.at(-1)?.text).toBe('Остановлено');
    });

    it('ход не запечатан (агент ничего не успел) — ленту не трогает', () => {
      expect(withSealedTurnCaughtUp(stopped(), file([asked]), 'notice', 'x')).toBeUndefined();
    });

    it('окно ушло дальше: новый ход или другой разговор — ленту не трогает', () => {
      const running = withUserMessage(stopped(), 'ещё');
      expect(withSealedTurnCaughtUp(running, file([asked, said]), 'notice', 'x')).toBeUndefined();
      const other = { ...stopped(), conversationId: 'c2' };
      expect(withSealedTurnCaughtUp(other, file([asked, said]), 'notice', 'x')).toBeUndefined();
    });
  });
});
