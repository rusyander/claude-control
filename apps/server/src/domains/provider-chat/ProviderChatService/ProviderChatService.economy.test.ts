import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { ProviderChatService, type ForeignWatchFeed } from './ProviderChatService.ts';
import type {
  ProviderChatRunEvent,
  ProviderChatRunLike,
  ProviderChatRunOptions,
} from '../ProviderChatRun/ProviderChatRun.ts';
import { appendMessage, createChat, readChat, writeChatLiveSession } from '../store/store.ts';
import { digestMessages } from '../live-session/live-session.ts';

/**
 * @covers ProviderChatService.ts — `setEconomyRun`, `setColdPlan`, `setWatchListener`
 * @scenario рычаги экономии группы чужого CLI ложатся слоем поверх тишины и под
 *   строкой о каталоге; «холодная» пауза бросает сессию CLI и открывает ход
 *   вводной панели; сторож групп видит старт и конец хода с сессией CLI.
 */

class FakeRun implements ProviderChatRunLike {
  emit?: (event: ProviderChatRunEvent) => void;
  options?: ProviderChatRunOptions;
  finish: () => void = () => {};
  start(options: ProviderChatRunOptions, onEvent: (event: ProviderChatRunEvent) => void) {
    this.options = options;
    this.emit = onEvent;
    return new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }
  stop(): void {}
}

const PROVIDER = { id: 'qwen', name: 'Qwen Code' } as ConfigProvider;
const SETTINGS = 'QWEN_CODE_SYSTEM_SETTINGS_PATH';

describe('ProviderChatService', () => {
  let dir: string;
  let run: FakeRun;
  let service: ProviderChatService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-economy-'));
    run = new FakeRun();
    service = new ProviderChatService(() => run);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const send = (text: string, chatId = 'wd') => {
    run = new FakeRun();
    service.send(dir, 'qwen', chatId, { text }, { provider: PROVIDER });
    return run;
  };

  it('economy layer sits after quiet, before note', () => {
    createChat(dir, 'qwen', { id: 'wd', workdir: dir, model: 'qwen3-coder' });
    const order: string[] = [];
    let economyRun: unknown;
    service.setWorkspaceNote(() => 'QA workspace: e2e');
    service.setChildRun(() => ({
      group: true,
      economy: GROUP_ECONOMY_DEFAULTS,
      compactWindow: 160_000,
    }));
    service.setQuietRun((_providerId, _group, env) => {
      order.push(`quiet:${env[SETTINGS] ?? ''}`);
      return { [SETTINGS]: '/quiet.json' };
    });
    service.setEconomyRun((providerId, request, env) => {
      order.push(`economy:${providerId}:${env[SETTINGS] ?? ''}`);
      economyRun = request;
      return { [SETTINGS]: '/economy.json', AGENTDECK_LEVER: '1' };
    });
    service.setSystemNote((_providerId, _note, env) => {
      order.push(`note:${env[SETTINGS] ?? ''}`);
      return { [SETTINGS]: '/note.json' };
    });

    const current = send('вопрос');

    expect(order).toEqual(['quiet:', 'economy:qwen:/quiet.json', 'note:/economy.json']);
    expect(economyRun).toEqual({
      economy: GROUP_ECONOMY_DEFAULTS,
      compactWindow: 160_000,
      model: 'qwen3-coder',
      // Каталог разговора — канал читает по нему настройки проекта CLI.
      workdir: dir,
    });
    expect(current.options?.platformEnv).toMatchObject({
      [SETTINGS]: '/note.json',
      AGENTDECK_LEVER: '1',
    });
    // Новый ключ рычага — настройка прогона: с живого сервера ход он не уводит.
    // Ключ файла настроек был и до рычагов — он остаётся обязательным.
    expect(current.options?.optionalEnvKeys).toEqual(['AGENTDECK_LEVER']);
  });

  it('economy request carries the contour window of the run model (route.modelContext)', () => {
    createChat(dir, 'qwen', { id: 'wd', workdir: dir });
    let economyRun: { modelContext?: number; model?: string } | undefined;
    service.setPlatformRouting(() => ({
      env: { OPENAI_BASE_URL: 'http://contour' },
      model: { model: 'contour-model', asked: '', source: 'catalog', replaced: false },
      modelContext: 131_072,
    }));
    service.setChildRun(() => ({ group: true, compactWindow: 100_000 }));
    service.setEconomyRun((_providerId, request) => {
      economyRun = request;
      return undefined;
    });
    send('вопрос');
    // Окно контура — второй источник окна у Qwen после его собственных настроек.
    expect(economyRun).toMatchObject({ model: 'contour-model', modelContext: 131_072 });
  });

  const notAsked: [string, () => ReturnType<Parameters<ProviderChatService['setChildRun']>[0]>][] =
    [
      ['обычный разговор', () => undefined],
      ['разбор (ребёнок, не группа)', () => ({ economy: GROUP_ECONOMY_DEFAULTS })],
      ['группа без рычагов', () => ({ group: true })],
    ];
  for (const [title, child] of notAsked) {
    it(`economy layer: ${title} — канал не зовётся`, () => {
      createChat(dir, 'qwen', { id: 'wd', workdir: dir });
      let asked = false;
      service.setChildRun(child);
      service.setEconomyRun(() => {
        asked = true;
        return { AGENTDECK_LEVER: '1' };
      });
      const current = send('вопрос');
      expect(asked).toBe(false);
      expect(current.options?.platformEnv ?? {}).not.toHaveProperty('AGENTDECK_LEVER');
    });
  }

  it('economy layer упал — ход всё равно отправлен, без рычагов', () => {
    createChat(dir, 'qwen', { id: 'wd', workdir: dir });
    service.setChildRun(() => ({ group: true, compactWindow: 160_000 }));
    service.setEconomyRun(() => {
      throw new Error('boom');
    });
    const current = send('вопрос');
    expect(current.options).toBeDefined();
    expect(current.options?.optionalEnvKeys).toBeUndefined();
  });

  /** Разговор из двух ходов с живой сессией CLI, покрывающей оба. */
  const seedSession = () => {
    createChat(dir, 'qwen', { id: 'wd', workdir: dir });
    for (const [role, content] of [
      ['user', 'первый'],
      ['assistant', 'ответ 1'],
      ['user', 'второй'],
      ['assistant', 'ответ 2'],
    ] as const) {
      appendMessage(dir, 'qwen', 'wd', { role, content });
    }
    const messages = readChat(dir, 'qwen', 'wd')!.messages;
    writeChatLiveSession(dir, 'qwen', 'wd', {
      kind: 'qwen-serve',
      id: 'sess-1',
      preamble: '',
      covered: messages.length,
      digest: digestMessages(messages),
      model: '',
      workdir: dir,
    });
  };

  it('cold plan fresh discards live session', () => {
    seedSession();
    let request: unknown;
    service.setChildRun(() => ({ group: true }));
    service.setColdPlan((asked) => {
      request = asked;
      return { kind: 'fresh', brief: 'BRIEF: где остановились', tail: 1, notice: 'Новая сессия.' };
    });

    const current = send('третий');

    expect(request).toMatchObject({
      providerId: 'qwen',
      chatId: 'wd',
      workdir: dir,
      session: { kind: 'qwen-serve', id: 'sess-1' },
    });
    expect((request as { messages: unknown[] }).messages).toHaveLength(4);
    // Только id: прогон удалит прежнюю сессию, а не продолжит её.
    expect(current.options?.liveSession).toEqual({
      previous: { kind: 'qwen-serve', id: 'sess-1' },
    });
    expect(current.options?.history.map((message) => message.content)).toEqual([
      'BRIEF: где остановились',
      'ответ 2',
      'третий',
    ]);
    // Вводная в переписку не пишется; строка в ленту — пишется.
    const stored = readChat(dir, 'qwen', 'wd')!.messages;
    expect(stored.map((message) => message.content)).not.toContain('BRIEF: где остановились');
    expect(stored.at(-1)).toMatchObject({ role: 'notice', content: 'Новая сессия.' });
  });

  it('cold plan resume (или решателя нет) — сессия продолжается, как до него', () => {
    seedSession();
    service.setChildRun(() => ({ group: true }));
    service.setColdPlan(() => ({ kind: 'resume' }));
    const current = send('третий');
    expect(current.options?.liveSession?.previous).toMatchObject({ id: 'sess-1', covered: 4 });
    expect(current.options?.history).toHaveLength(5);
  });

  it('cold plan не спрашивается у разговора, который не группа', () => {
    seedSession();
    let asked = false;
    service.setColdPlan(() => {
      asked = true;
      return { kind: 'fresh', brief: 'B', tail: 0 };
    });
    const current = send('третий');
    expect(asked).toBe(false);
    expect(current.options?.liveSession?.previous).toMatchObject({ id: 'sess-1', covered: 4 });
  });

  it('watch listener: старт с продолжаемой сессией, конец — с сессией хода', () => {
    seedSession();
    const feeds: ForeignWatchFeed[] = [];
    service.setChildRun(() => ({ group: true }));
    service.setWatchListener((feed) => feeds.push(feed));

    const current = send('третий');
    current.emit?.({
      type: 'done',
      reply: 'ответ 3',
      transport: 'live',
      liveSession: { kind: 'qwen-serve', id: 'sess-2', preamble: '' },
    } as never);

    expect(feeds).toEqual([
      {
        kind: 'start',
        providerId: 'qwen',
        chatId: 'wd',
        sessionId: 'sess-1',
        group: true,
        cwd: dir,
      },
      { kind: 'finish', providerId: 'qwen', chatId: 'wd', sessionId: 'sess-2', group: true },
    ]);
  });

  it('watch listener: ход на локальной модели помечен local — R2 сторожа молчит, кэша провайдера нет', () => {
    createChat(dir, 'qwen', { id: 'wd', workdir: dir });
    const starts: ForeignWatchFeed[] = [];
    service.setWatchListener((feed) => {
      if (feed.kind === 'start') starts.push(feed);
    });
    service.setPlatformRouting(() => ({
      env: { OPENAI_BASE_URL: 'http://127.0.0.1:1/x' },
      localLimits: { contextWindow: 65_536, timeoutMs: 600_000, idleMs: 300_000 },
    }));
    send('локально');
    // Второй разговор — свой ход (первый ещё идёт), маршрут уже облачный.
    createChat(dir, 'qwen', { id: 'wd2', workdir: dir });
    service.setPlatformRouting(() => ({ env: {} }));
    send('облако', 'wd2');
    expect(starts.map((feed) => feed.kind === 'start' && feed.local)).toEqual([true, undefined]);
  });

  it('watch listener упал — ход всё равно отправлен', () => {
    createChat(dir, 'qwen', { id: 'wd', workdir: dir });
    service.setWatchListener(() => {
      throw new Error('boom');
    });
    const current = send('вопрос');
    expect(current.options).toBeDefined();
  });
});
