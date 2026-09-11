import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { foreignChatKey, parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import type { ConfigProvider } from '../../providers/types.ts';
import { createTreeRuns } from './tree-runs.ts';
import type { ChatRunRegistry } from './ChatRunRegistry.ts';
import type { RunOptions } from './ChatRunner.ts';
import { ProviderChatService } from '../provider-chat/ProviderChatService.ts';
import type { ProviderChatRunOptions } from '../provider-chat/ProviderChatRun.ts';
import { createChat, appendMessage, readChat } from '../provider-chat/store.ts';

/**
 * Переходник прогонов дерева: развилка по КЛЮЧУ связи.
 *
 * Проверяется ровно то, ради чего он и заведён: чужой разговор входит в дерево
 * теми же четырьмя методами, что и прогон Claude, а ключи двух пространств не
 * сталкиваются — по «голому» идентификатору чужая связь не находится, и наоборот.
 */

const PROVIDER = { id: 'codex', name: 'Codex' } as ConfigProvider;
const OPTIONS = { prompt: 'Задание', cwd: 'C:/proj' } as RunOptions;

describe('tree-runs', () => {
  let dir: string;
  let chats: ProviderChatService;
  let sent: ProviderChatRunOptions[];
  let calls: string[];
  let runs: ReturnType<typeof createTreeRuns>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tree-runs-'));
    sent = [];
    calls = [];
    chats = new ProviderChatService(() => ({
      start: async (options, onEvent) => {
        sent.push(options);
        onEvent({ type: 'done', reply: 'готово', transport: 'stream' });
      },
      stop: () => undefined,
    }));

    const registry = {
      describe: (key: string) => {
        calls.push(`describe:${key}`);
        return { key, status: 'running', options: OPTIONS, meta: {} };
      },
      stop: (key: string) => {
        calls.push(`stop:${key}`);
        return true;
      },
      start: (key: string) => {
        calls.push(`start:${key}`);
        return true;
      },
      isRunning: (key: string) => {
        calls.push(`isRunning:${key}`);
        return true;
      },
    } as unknown as ChatRunRegistry;

    runs = createTreeRuns({
      registry,
      chats,
      appDataDir: () => dir,
      provider: (id) => (id === 'codex' ? PROVIDER : undefined),
      models: () => [],
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe('ключи', () => {
    it('именованный ключ разбирается, «голый» — нет', () => {
      expect(parseForeignChatKey(foreignChatKey('codex', 'c1'))).toEqual({
        providerId: 'codex',
        chatId: 'c1',
      });
      expect(parseForeignChatKey('9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f')).toBe(undefined);
      expect(parseForeignChatKey('new-1788971922396-0')).toBe(undefined);
    });

    it('Claude именованным ключом не адресуется — у него свои', () => {
      expect(parseForeignChatKey('claude:c1')).toBe(undefined);
    });

    it('половинки ключа не считаются ключом', () => {
      expect(parseForeignChatKey(':c1')).toBe(undefined);
      expect(parseForeignChatKey('codex:')).toBe(undefined);
    });
  });

  describe('развилка', () => {
    it('ключ Claude уходит в реестр прогонов как был', () => {
      runs.describe('c-1');
      runs.stop('c-1');
      runs.start('c-1', OPTIONS, {});
      runs.isRunning('c-1');

      expect(calls).toEqual(['describe:c-1', 'stop:c-1', 'start:c-1', 'isRunning:c-1']);
    });

    it('именованный ключ реестра не касается вовсе', () => {
      createChat(dir, 'codex', { id: 'c1', workdir: dir });
      const key = foreignChatKey('codex', 'c1');

      runs.describe(key);
      runs.stop(key);
      runs.isRunning(key);

      expect(calls).toEqual([]);
    });
  });

  describe('чужой прогон', () => {
    it('снимок несёт последний вопрос и каталог разговора', () => {
      createChat(dir, 'codex', { id: 'c1', workdir: dir });
      appendMessage(dir, 'codex', 'c1', { role: 'user', content: 'Первый' });
      appendMessage(dir, 'codex', 'c1', { role: 'assistant', content: 'Ответ' });
      appendMessage(dir, 'codex', 'c1', { role: 'user', content: 'Второй' });

      expect(runs.describe(foreignChatKey('codex', 'c1'))).toMatchObject({
        key: 'codex:c1',
        status: 'done',
        options: { prompt: 'Второй', cwd: dir },
      });
    });

    it('разговора нет — снимка нет, а не выдуманный пустой', () => {
      expect(runs.describe(foreignChatKey('codex', 'нет'))).toBe(undefined);
    });

    it('идущий ответ виден и снимком, и вопросом «идёт ли»', () => {
      createChat(dir, 'codex', { id: 'c1', workdir: dir });
      const key = foreignChatKey('codex', 'c1');
      expect(runs.isRunning(key)).toBe(false);

      // Прогон, который живёт, пока его не погасят: настоящий CLI кончается
      // смертью процесса, и только она снимает «идёт».
      let finish: (() => void) | undefined;
      const service = new ProviderChatService(() => ({
        start: (_options, onEvent) =>
          new Promise<void>((resolve) => {
            finish = () => {
              onEvent({ type: 'error', error: 'снято', reason: 'cli_error' });
              resolve();
            };
          }),
        stop: () => finish?.(),
      }));
      const live = createTreeRuns({
        registry: {} as ChatRunRegistry,
        chats: service,
        appDataDir: () => dir,
        provider: () => PROVIDER,
        models: () => [],
      });
      service.send(dir, 'codex', 'c1', { text: 'Вопрос' }, { provider: PROVIDER });

      expect(live.isRunning(key)).toBe(true);
      expect(live.describe(key)).toMatchObject({ status: 'running' });
      expect(live.stop(key)).toBe(true);
      expect(live.isRunning(key)).toBe(false);
    });

    /**
     * Продолжения «с того же места» у чужого CLI нет: сессии не существует, и
     * продолжение — это новый запуск с тем же заданием.
     */
    it('запуск шлёт задание заново тем провайдером, что назван КЛЮЧОМ', () => {
      createChat(dir, 'codex', { id: 'c1', workdir: dir });

      expect(runs.start(foreignChatKey('codex', 'c1'), OPTIONS, {})).toBe(true);

      expect(sent).toHaveLength(1);
      expect(readChat(dir, 'codex', 'c1')?.messages.at(0)?.content).toBe('Задание');
    });

    /**
     * Дописка (инициативы панели, планка сдачи у понижённой ступени) нигде не
     * хранится, а собирается заново по шапке разговора. Продолжение дерева после
     * паузы (Т5) без неё поехало бы работой без планки сдачи.
     */
    it('продолжённый прогон несёт дописку, собранную по шапке разговора', () => {
      createChat(dir, 'codex', { id: 'c1', workdir: dir });
      const withPrefix = createTreeRuns({
        registry: {} as ChatRunRegistry,
        chats,
        appDataDir: () => dir,
        provider: () => PROVIDER,
        models: () => [],
        systemPrefix: (providerId, chatId) => `дописка ${providerId}/${chatId}`,
      });

      expect(withPrefix.start(foreignChatKey('codex', 'c1'), OPTIONS, {})).toBe(true);

      expect(sent.at(0)?.systemPrefix).toBe('дописка codex/c1');
    });

    it('провайдера из ключа не знаем — прогон не запускается, а не идёт чужим CLI', () => {
      createChat(dir, 'gemini', { id: 'g1' });

      expect(runs.start(foreignChatKey('gemini', 'g1'), OPTIONS, {})).toBe(false);
      expect(sent).toHaveLength(0);
    });
  });
});
