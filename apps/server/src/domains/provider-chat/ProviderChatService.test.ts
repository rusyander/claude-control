import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderChatEvent } from '@agentdeck/contracts';
import type { ConfigProvider } from '../../providers/types.ts';
import { ProviderChatService, type ProviderChatSubscriber } from './ProviderChatService.ts';
import type { ProviderChatRunEvent, ProviderChatRunLike } from './ProviderChatRun.ts';
import { createChat, readChat } from './store.ts';

/**
 * Живые ответы чужого провайдера. Настоящий CLI здесь не запускается — прогон
 * подменён, и проверяется то, что принадлежит службе: запись результата в
 * переписку, доставка кусков подписчикам и поведение при остановке.
 */

/** Прогон под ручным управлением: события шлёт тест, когда захочет. */
class FakeRun implements ProviderChatRunLike {
  emit: ((event: ProviderChatRunEvent) => void) | undefined;
  stopped = false;
  options: unknown;

  start(options: unknown, onEvent: (event: ProviderChatRunEvent) => void): Promise<void> {
    this.options = options;
    this.emit = onEvent;
    return new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }

  stop(): void {
    this.stopped = true;
  }

  finish: () => void = () => {};
}

const PROVIDER = { id: 'codex', name: 'Codex' } as ConfigProvider;

describe('ProviderChatService', () => {
  let dir: string;
  let run: FakeRun;
  let service: ProviderChatService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-svc-'));
    run = new FakeRun();
    service = new ProviderChatService(() => run);
    createChat(dir, 'codex', { id: 'chat' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const send = (text = 'Вопрос'): ReturnType<ProviderChatService['send']> =>
    service.send(dir, 'codex', 'chat', { text }, { provider: PROVIDER });

  const collect = (): { events: ProviderChatEvent[]; closed: number } => {
    const state = { events: [] as ProviderChatEvent[], closed: 0 };
    const subscriber: ProviderChatSubscriber = {
      send: (event) => state.events.push(event),
      close: () => {
        state.closed += 1;
      },
    };
    service.subscribe('chat', subscriber);
    return state;
  };

  it('записывает вопрос сразу, не дожидаясь ответа', () => {
    const outcome = send('Почини сборку');

    expect(outcome.ok).toBe(true);
    expect(outcome.message?.content).toBe('Почини сборку');
    expect(readChat(dir, 'codex', 'chat')?.messages).toHaveLength(1);
  });

  it('отдаёт куски подписчикам и копит их в состоянии', () => {
    send();
    const seen = collect();

    run.emit?.({ type: 'delta', text: 'Раз' });
    run.emit?.({ type: 'delta', text: ' два' });

    expect(seen.events).toEqual([
      { type: 'delta', text: 'Раз' },
      { type: 'delta', text: ' два' },
    ]);
    expect(service.status('chat')).toMatchObject({ isRunning: true, partial: 'Раз два' });
  });

  it('дописывает готовый ответ в переписку и закрывает подписчиков', () => {
    send();
    const seen = collect();

    run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });

    const messages = readChat(dir, 'codex', 'chat')?.messages ?? [];
    expect(messages.map((message) => message.content)).toEqual(['Вопрос', 'Готово']);
    expect(messages[1]?.transport).toBe('stream');
    expect(seen.events.at(-1)?.type).toBe('done');
    expect(seen.closed).toBe(1);
    expect(service.status('chat').isRunning).toBe(false);
  });

  it('ошибку тоже сохраняет — но помечает, чтобы она не ушла в контекст', () => {
    send();
    const seen = collect();

    run.emit?.({ type: 'error', error: 'CLI не найден', reason: 'cli_error' });

    const last = readChat(dir, 'codex', 'chat')?.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', content: 'CLI не найден', failed: true });
    expect(seen.events.at(-1)).toEqual({
      type: 'error',
      error: 'CLI не найден',
      reason: 'cli_error',
    });
  });

  it('отказывает во втором вопросе, пока идёт ответ на первый', () => {
    send();

    expect(send('Ещё')).toEqual({ ok: false, reason: 'already_running' });
    expect(readChat(dir, 'codex', 'chat')?.messages).toHaveLength(1);
  });

  it('после завершения ответа принимает следующий вопрос', () => {
    send();
    run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });

    expect(send('Ещё').ok).toBe(true);
  });

  it('несуществующий разговор — отказ, а не пустой прогон', () => {
    const outcome = service.send(dir, 'codex', 'missing', { text: 'Э' }, { provider: PROVIDER });

    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
  });

  it('остановка гасит прогон и сообщает об этом сразу', () => {
    send();
    const seen = collect();

    expect(service.stop('chat')).toBe(true);
    expect(run.stopped).toBe(true);
    expect(seen.events).toContainEqual({ type: 'stopped' });
  });

  it('сказанное до остановки остаётся ответом', () => {
    send();
    service.stop('chat');
    run.emit?.({ type: 'done', reply: 'Половина', transport: 'stream' });

    expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)?.content).toBe('Половина');
  });

  it('останавливать нечего — честное «нет»', () => {
    expect(service.stop('chat')).toBe(false);
  });

  it('гасит все прогоны разом', () => {
    send();
    service.stopAll();

    expect(run.stopped).toBe(true);
  });

  it('подписка живёт до отписки, дальше кусков не получает', () => {
    send();
    const state: ProviderChatEvent[] = [];
    const unsubscribe = service.subscribe('chat', {
      send: (event) => state.push(event),
      close: () => {},
    });

    run.emit?.({ type: 'delta', text: 'Раз' });
    unsubscribe();
    run.emit?.({ type: 'delta', text: 'Два' });

    expect(state).toEqual([{ type: 'delta', text: 'Раз' }]);
  });

  it('подписка на уже законченный ответ закрывается сразу', () => {
    let closed = 0;
    service.subscribe('chat', { send: () => {}, close: () => (closed += 1) });

    expect(closed).toBe(1);
  });

  it('состояние неизвестного разговора не притворяется идущим', () => {
    expect(service.status('nobody')).toEqual({ chatId: 'nobody', isRunning: false, partial: '' });
  });

  it('передаёт прогону переписку вместе с новым вопросом и рабочий каталог', () => {
    createChat(dir, 'codex', { id: 'wd', workdir: dir });
    service.send(dir, 'codex', 'wd', { text: 'Вопрос' }, { provider: PROVIDER });

    expect(run.options).toMatchObject({ chatId: 'wd', appDataDir: dir, workdir: dir });
    expect((run.options as { history: unknown[] }).history).toHaveLength(1);
  });

  it('родитель разделения получает сводку детей в ходе, но не в переписке (Д6)', () => {
    const brief = '<agentdeck-children>\n1. «Шапка» — работает.\n</agentdeck-children>';
    service.setChildrenBrief((providerId, chatId) =>
      providerId === 'codex' && chatId === 'chat' ? brief : undefined,
    );

    send('исправлено?');

    const history = (run.options as { history: { content: string }[] }).history;
    expect(history.at(-1)?.content).toBe(`${brief}\n\nисправлено?`);
    // Человек видит в переписке то, что написал он, а не панель.
    expect(readChat(dir, 'codex', 'chat')?.messages.map((message) => message.content)).toEqual([
      'исправлено?',
    ]);
  });

  /**
   * Время ответа (Т1 партии чужих CLI). Меряет панель по своему прогону —
   * расход чужие CLI отдают не все и по-разному, а часы есть всегда. Меряется
   * настоящими часами, поэтому проверяется не число, а его наличие и знак.
   */
  describe('время работы', () => {
    it('готовый ответ несёт время прогона', () => {
      send();
      run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });

      const last = readChat(dir, 'codex', 'chat')?.messages.at(-1);
      expect(typeof last?.durationMs).toBe('number');
      expect(last?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('провалившийся прогон время тоже несёт', () => {
      send();
      run.emit?.({ type: 'error', error: 'CLI не найден', reason: 'cli_error' });

      expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('снятый кнопкой ответ время тоже несёт', () => {
      send();
      service.stop('chat');
      run.emit?.({ type: 'done', reply: 'Половина', transport: 'stream' });

      expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)?.durationMs).toBeGreaterThanOrEqual(0);
    });

    /**
     * Пауза дерева (Т2) останавливает прогон, который может не успеть сказать
     * ни слова. Пустой пузырь читался бы как «CLI ответил молчанием», а при
     * ночной паузе их копилось бы по одному на каждую остановку.
     */
    it('остановленный молча прогон записан как оборванный, а не пустым ответом', () => {
      send();
      service.stop('chat');
      run.emit?.({ type: 'done', reply: '   ', transport: 'stream' });

      const last = readChat(dir, 'codex', 'chat')?.messages.at(-1);
      expect(last?.failed).toBe(true);
      expect(last?.content).toBe('Прогон остановлен: ответа не было.');
      expect(last?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('сказанное до остановки остаётся ответом, а не следом обрыва', () => {
      send();
      service.stop('chat');
      run.emit?.({ type: 'done', reply: 'Половина', transport: 'stream' });

      const last = readChat(dir, 'codex', 'chat')?.messages.at(-1);
      expect(last?.content).toBe('Половина');
      expect(last?.failed).toBeUndefined();
    });

    it('вопрос человека времени не несёт: он не прогон', () => {
      send();

      expect(readChat(dir, 'codex', 'chat')?.messages[0]?.durationMs).toBeUndefined();
    });
  });

  /**
   * Калитка запросов отказывает ДО запуска CLI, а реплика пишется в файл
   * раньше отказа. Оставленная в переписке, она уезжала чужому CLI следующим
   * сообщением внутри `history`: калитка смотрит только ПОСЛЕДНЮЮ реплику и
   * второй раз эту уже не видит — запрет обходился простым «напиши ещё».
   */
  describe('отказ калитки до запуска', () => {
    it('отказанная реплика снята из переписки и не уезжает следующим сообщением', () => {
      send('Вот ключ sk-живой-ключ, почини деплой');
      run.emit?.({
        type: 'error',
        error: 'Калитка отказала: Ключи доступа',
        reason: 'hook_blocked',
      });

      const afterBlock = readChat(dir, 'codex', 'chat');
      expect(
        afterBlock?.messages.some((message) => message.content.includes('sk-живой-ключ')),
      ).toBe(false);

      // Главное утверждение — не про файл, а про то, что уезжает цели.
      run = new FakeRun();
      service = new ProviderChatService(() => run);
      send('Почини деплой, пожалуйста');
      const history = (run.options as { history: { content: string }[] }).history;

      // Заметка об отказе в переписке ОСТАЁТСЯ — человек обязан видеть причину,
      // и значения, из-за которого сработало правило, в ней нет. Уехать не
      // должен именно запрещённый текст.
      expect(history.some((message) => message.content.includes('sk-живой-ключ'))).toBe(false);
      expect(history.map((message) => message.content)).toEqual([
        'Калитка отказала: Ключи доступа',
        'Почини деплой, пожалуйста',
      ]);
    });

    it('отказ ПОСЛЕ ответа реплику не трогает: она уже уехала', () => {
      send('Обычный вопрос');
      run.emit?.({ type: 'delta', text: 'ответ' });
      run.emit?.({ type: 'done', reply: 'ответ', transport: 'stream' });
      run.emit?.({
        type: 'error',
        error: 'Хук события Stop потребовал продолжения',
        reason: 'hook_blocked',
      });

      const chat = readChat(dir, 'codex', 'chat');
      expect(chat?.messages.some((message) => message.content === 'Обычный вопрос')).toBe(true);
    });
  });

  /**
   * Точка, на которой висит конвейер звеньев (`cascade.ts`). Важно не «зовётся
   * ли», а ЧТО в ней написано: снятый человеком ответ не законченная работа, и
   * заводить по нему ревью нельзя.
   */
  describe('слушатель завершения', () => {
    it('сообщает об удачном ответе вместе с его текстом', () => {
      const seen = vi.fn();
      service.setFinishedListener(seen);
      send();
      run.emit?.({ type: 'delta', text: 'Гото' });
      run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });

      // Момент старта уезжает вместе с ответом: по нему продолжение в чистой
      // сессии (Т7) проверяет, что файл-опора обновлён ИМЕННО этим прогоном.
      expect(seen).toHaveBeenCalledWith({
        providerId: 'codex',
        appDataDir: dir,
        chatId: 'chat',
        ok: true,
        text: 'Готово',
        startedAt: expect.any(Number),
      });
    });

    it('снятый кнопкой ответ законченным не считает', () => {
      const seen = vi.fn();
      service.setFinishedListener(seen);
      send();
      run.emit?.({ type: 'delta', text: 'начал' });
      service.stop('chat');
      // Остановленный прогон закрывается тем, что успел сказать, — событие то же
      // самое, `done`, и отличить его можно только по отметке остановки.
      run.emit?.({ type: 'done', reply: 'начал', transport: 'stream' });

      expect(seen).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    });

    it('ошибка прогона тоже завершение, но не удачное', () => {
      const seen = vi.fn();
      service.setFinishedListener(seen);
      send();
      run.emit?.({ type: 'error', error: 'CLI умер', reason: 'cli_error' });

      expect(seen).toHaveBeenCalledWith(expect.objectContaining({ ok: false, text: '' }));
    });

    it('упавший слушатель не портит уже записанный ответ', () => {
      service.setFinishedListener(() => {
        throw new Error('звено не завелось');
      });
      send();

      expect(() =>
        run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' }),
      ).not.toThrow();
      expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)?.content).toBe('Готово');
    });
  });

  describe('вызовы инструментов через контур (развилка 5)', () => {
    const routed = (): void =>
      service.setPlatformRouting(() => ({ env: { OPENAI_BASE_URL: 'http://127.0.0.1:1/x' } }));

    it('ответ через контур несёт счёт вызовов из журнала шлюза с момента старта', () => {
      routed();
      const since = vi.fn(() => 0);
      service.setContourToolCalls(since);
      send();
      run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });

      const answer = readChat(dir, 'codex', 'chat')?.messages.at(-1);
      expect(answer?.contourToolCalls).toBe(0);
      expect(since).toHaveBeenCalledWith(expect.any(Number));
    });

    it('мимо контура счёта нет: подсказывать не о чем', () => {
      service.setContourToolCalls(() => 3);
      send();
      run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });
      expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)?.contourToolCalls).toBeUndefined();
    });

    it('сжатие ищется по метке ЭТОГО прогона, и та же метка ушла в маршрут', () => {
      const resolve = vi.fn((_c: string, _a: string, _tag: string) => ({
        env: { OPENAI_BASE_URL: 'http://127.0.0.1:1/x' },
      }));
      service.setPlatformRouting(resolve);
      const check = vi.fn((tag: string) => tag === resolve.mock.calls[0]?.[2]);
      service.setContourSummarized(check);
      send();
      run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });

      const tag = resolve.mock.calls[0]?.[2];
      expect(tag).toMatch(/^[0-9a-f-]{36}$/);
      expect(check).toHaveBeenCalledWith(tag);
      expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)?.contextSummarized).toBe(true);
    });

    it('у каждого сообщения своя метка: сжатие прошлого прогона не подписывает новый', () => {
      const tags: string[] = [];
      service.setPlatformRouting((_c, _a, tag) => {
        tags.push(tag);
        return { env: { OPENAI_BASE_URL: 'http://127.0.0.1:1/x' } };
      });
      service.setContourSummarized((tag) => tag === tags[0]);
      send();
      run.emit?.({ type: 'done', reply: 'Первый', transport: 'stream' });
      run.finish();
      run = new FakeRun();
      send('Ещё');
      run.emit?.({ type: 'done', reply: 'Второй', transport: 'stream' });

      expect(tags).toHaveLength(2);
      expect(tags[0]).not.toBe(tags[1]);
      const answers = readChat(dir, 'codex', 'chat')?.messages.filter(
        (m) => m.role === 'assistant',
      );
      expect(answers?.map((m) => m.contextSummarized ?? false)).toEqual([true, false]);
    });

    it('мимо контура сжатие не спрашивается', () => {
      const check = vi.fn(() => true);
      service.setContourSummarized(check);
      send();
      run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });
      expect(check).not.toHaveBeenCalled();
      expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)).not.toHaveProperty(
        'contextSummarized',
      );
    });

    it('шлюз запросов не видел — поля нет, а не «ноль»', () => {
      routed();
      service.setContourToolCalls(() => undefined);
      send();
      run.emit?.({ type: 'done', reply: 'Готово', transport: 'stream' });
      expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)).not.toHaveProperty(
        'contourToolCalls',
      );
    });
  });

  it('упавший прогон превращается в ошибку разговора, а не в тишину', async () => {
    const broken: ProviderChatRunLike = {
      start: () => Promise.reject(new Error('всё сломалось')),
      stop: () => {},
    };
    const failing = new ProviderChatService(() => broken);
    failing.send(dir, 'codex', 'chat', { text: 'Вопрос' }, { provider: PROVIDER });

    await vi.waitFor(() => {
      expect(readChat(dir, 'codex', 'chat')?.messages.at(-1)).toMatchObject({
        failed: true,
        content: 'всё сломалось',
      });
    });
  });
});
