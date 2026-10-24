import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { AppStore } from '../../../lib/app-store/store.ts';
import type { SplitPlanGroupRecord } from '../../../lib/app-store/app-store.types.ts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { createForeignColdPlan } from '../../chat/cold-continuation/foreign-cold-plan.ts';
import { qwenProjectSlug } from '../../chat/token-ledger/foreign/foreign-transcript.ts';
import { GroupWatcher } from '../../chat/token-ledger/watch/group-watcher.ts';
import { ownLocalEndpoint } from '../own-endpoint/own-endpoint.ts';
import { digestMessages } from '../live-session/live-session.ts';
import { appendMessage, createChat, readChat, writeChatLiveSession } from '../store/store.ts';
import { ProviderChatService } from './ProviderChatService.ts';
import type {
  ProviderChatRunEvent,
  ProviderChatRunLike,
  ProviderChatRunOptions,
} from '../ProviderChatRun/ProviderChatRun.ts';

/**
 * @covers ProviderChatService.ts — `setOwnLocal` (один ответ решателю паузы и сторожу групп)
 * @scenario группа Qwen Code, направленная СВОИМИ настройками на локальный сервер
 *   моделей (`OPENAI_BASE_URL` на 127.0.0.1, мимо контура), после паузы дольше срока
 *   кэша провайдера (5 минут): решатель паузы (`createForeignColdPlan`) продолжает
 *   сессию, а не начинает новую, и сторож групп не поднимает R2 «холодный кэш», хотя
 *   сервер сообщал чтение кэша и оно упало. Тот же ход с облачным адресом — новая
 *   сессия и R2: проверка умеет краснеть. Решатель, сторож и `ownLocalEndpoint` —
 *   настоящие; подключены так же, как в `bootstrap/runtime/runtime.ts`.
 */

class FakeRun implements ProviderChatRunLike {
  emit?: (event: ProviderChatRunEvent) => void;
  options?: ProviderChatRunOptions;
  start(options: ProviderChatRunOptions, onEvent: (event: ProviderChatRunEvent) => void) {
    this.options = options;
    this.emit = onEvent;
    return new Promise<void>(() => {});
  }
  stop(): void {}
}

const PROVIDER = { id: 'qwen', name: 'Qwen Code' } as ConfigProvider;
const MIN = 60_000;
const T0 = Date.parse('2026-10-22T10:00:00Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const CLOUD_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

/** Вызов модели той же формы, что пишет qwen 0.24.3 (`ui_telemetry`). */
const call = (ms: number, id: string, prompt: number, cached: number): string =>
  `${JSON.stringify({
    type: 'system',
    subtype: 'ui_telemetry',
    timestamp: at(ms),
    systemPayload: {
      uiEvent: {
        'event.name': 'qwen-code.api_response',
        response_id: id,
        model: 'qwen3-coder:30b',
        input_token_count: prompt,
        cached_content_token_count: cached,
        output_token_count: 20,
      },
    },
  })}\n`;
const answer = (ms: number, text: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: at(ms),
    message: { role: 'model', parts: [{ text }] },
  })}\n`;

describe('ProviderChatService own local endpoint (Qwen Code on its own local server)', () => {
  let dir: string;
  let copy: string;
  let file: string;
  let now: number;
  let run: FakeRun;
  let service: ProviderChatService;
  let ownQwenHome: string;
  const key = foreignChatKey('qwen', 'child');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-own-local-'));
    copy = join(dir, 'copy');
    mkdirSync(copy);
    // Переписка CLI — в доме Qwen Code набора панели, там её ищет решатель паузы.
    const chats = join(dir, 'kit', 'qwen-home', 'projects', qwenProjectSlug(copy), 'chats');
    mkdirSync(chats, { recursive: true });
    file = join(chats, 's1.jsonl');
    // Личные настройки CLI — свои, временные: вход OpenAI-совместимый.
    ownQwenHome = join(dir, 'own-qwen');
    mkdirSync(ownQwenHome);
    writeFileSync(
      join(ownQwenHome, 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'openai' } } }),
    );
    now = T0;
    run = new FakeRun();
    service = new ProviderChatService(() => run);
    // Подключение — как в runtime: окружение прогона целиком, контуров нет, шлюз погашен.
    service.setOwnLocal((providerId, env, runInfo) =>
      ownLocalEndpoint({
        providerId,
        env,
        ...runInfo,
        platformIds: [],
        gatewayPort: 0,
        home: dir,
      }),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Группа разделения, чей CLI идёт по `baseUrl` (свой сервер или облако). */
  const groupOn = (baseUrl: string) =>
    service.setChildRun(() => ({
      group: true,
      env: {
        QWEN_HOME: ownQwenHome,
        QWEN_CODE_SYSTEM_SETTINGS_PATH: join(dir, 'machine.json'),
        OPENAI_BASE_URL: baseUrl,
      },
    }));

  /** Разговор из двух ходов с живой сессией `s1`, покрывающей оба. */
  const seedSession = () => {
    createChat(dir, 'qwen', { id: 'child', workdir: copy });
    for (const [role, content] of [
      ['user', 'первый'],
      ['assistant', 'ответ 1'],
      ['user', 'второй'],
      ['assistant', 'ответ 2'],
    ] as const) {
      appendMessage(dir, 'qwen', 'child', { role, content });
    }
    const messages = readChat(dir, 'qwen', 'child')!.messages;
    writeChatLiveSession(dir, 'qwen', 'child', {
      kind: 'qwen-serve',
      id: 's1',
      preamble: '',
      covered: messages.length,
      digest: digestMessages(messages),
      model: '',
      workdir: copy,
    });
  };

  const send = (text: string) => {
    run = new FakeRun();
    service.send(dir, 'qwen', 'child', { text }, { provider: PROVIDER });
    return run;
  };

  describe('cold planner (freshOnColdResume on)', () => {
    const plan = () => {
      const store = {
        getSettings: () => ({
          groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, freshOnColdResume: true },
        }),
        getChatLink: (asked: string) =>
          asked === key
            ? { parentChatId: 'p', groupIndex: 0, createdAt: at(0), task: 'Finish the group.' }
            : undefined,
        getSplitPlan: () => undefined,
      } as unknown as Pick<AppStore, 'getChatLink' | 'getSettings' | 'getSplitPlan'>;
      service.setColdPlan(createForeignColdPlan({ store, appDataDir: dir, now: () => now }));
    };
    const pausedTurn = (baseUrl: string) => {
      seedSession();
      writeFileSync(
        file,
        call(1000, 'c1', 9000, 0) + call(2000, 'c2', 40_000, 30_000) + answer(3000, 'Step done.'),
      );
      groupOn(baseUrl);
      plan();
      // Пауза 6 минут — дольше 5-минутного кэша провайдера Qwen.
      now = T0 + 3000 + 6 * MIN;
      return send('третий');
    };

    it('own local server past the TTL — the session continues, no fresh start', () => {
      const current = pausedTurn(LOCAL_URL);
      expect(current.options?.liveSession?.previous).toMatchObject({ id: 's1', covered: 4 });
      expect(current.options?.history).toHaveLength(5);
      const stored = readChat(dir, 'qwen', 'child')!.messages;
      expect(stored.some((message) => message.role === 'notice')).toBe(false);
    });

    it('control: the same pause on a cloud address starts fresh', () => {
      const current = pausedTurn(CLOUD_URL);
      expect(current.options?.liveSession).toEqual({ previous: { kind: 'qwen-serve', id: 's1' } });
      expect(current.options?.history[0]?.content).toContain('Finish the group.');
    });
  });

  describe('group watcher R2 (freshOnColdResume off)', () => {
    const watch = () => {
      const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
      const watcher = new GroupWatcher({
        settings: () => ({ ...GROUP_WATCH_DEFAULTS }),
        resolve: (asked) =>
          asked === key
            ? { chatId: asked, parentChatId: 'parent', groupIndex: 1, stage: 'work', cwd: copy }
            : undefined,
        group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
        save: () => {},
        node: () => ({ running: true, paused: false }),
        transcript: (_id, hint) => (hint?.provider === 'qwen' ? file : undefined),
        now: () => now,
        makeId: () => 'id',
        plans: () => ({ parent: { groups: [group] } }),
      });
      // Слушатель — как в runtime (`providerChats.setWatchListener`).
      service.setWatchListener((feed) => {
        if (!feed.group) return;
        const chatKey = foreignChatKey(feed.providerId, feed.chatId);
        const sessionId = feed.sessionId ?? chatKey;
        watcher.onFeed(
          chatKey,
          feed.kind === 'start'
            ? {
                kind: 'start',
                sessionId,
                cwd: feed.cwd,
                detached: true,
                provider: feed.providerId,
                ...(feed.local ? { local: true } : {}),
              }
            : { kind: 'finish', sessionId },
        );
      });
      return { watcher, r2: () => (group.watch?.signals ?? []).filter((s) => s.rule === 'R2') };
    };
    const resumedAfterPause = (baseUrl: string) => {
      const w = watch();
      // Первый ход: 9 тысяч без кэша (база), затем 40 тысяч, 30 из них из кэша.
      w.watcher.onFeed(key, {
        kind: 'start',
        sessionId: key,
        cwd: copy,
        detached: true,
        provider: 'qwen',
      });
      writeFileSync(file, call(1000, 'c1', 9000, 0) + call(2000, 'c2', 40_000, 30_000));
      now = T0 + 10_000;
      w.watcher.onFeed(key, { kind: 'finish', sessionId: 's1' });
      // Продолжение той же сессии через 6 минут — ходом панели; чтение кэша упало.
      seedSession();
      groupOn(baseUrl);
      now = T0 + 2000 + 6 * MIN - 1000;
      const current = send('третий');
      appendFileSync(file, call(2000 + 6 * MIN, 'c3', 70_000, 0));
      now = T0 + 2000 + 6 * MIN + 5000;
      current.emit?.({
        type: 'done',
        reply: 'ответ 3',
        transport: 'live',
        liveSession: { kind: 'qwen-serve', id: 's1', preamble: '' },
      } as never);
      return w.r2();
    };

    it('own local server — no R2 although the cache read dropped after the pause', () => {
      expect(resumedAfterPause(LOCAL_URL)).toEqual([]);
    });

    it('control: the same resume on a cloud address raises R2', () => {
      expect(resumedAfterPause(CLOUD_URL)).toHaveLength(1);
    });
  });
});
