import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TelegramEvent } from '@agentdeck/contracts';
import { getProvider } from '../../providers/registry.ts';
import { createRunNotifier } from '../remote-notify.ts';
import { createTelegramNotifier } from '../notify/telegram.ts';
import { readToken, writeToken } from '../integrations/store.ts';
import { ProviderChatService } from './ProviderChatService.ts';
import { ProviderChatRun } from './ProviderChatRun.ts';
import { createChat } from './store.ts';

/**
 * Уведомления о конце хода чужого CLI — тем же отправителем, что у Claude.
 *
 * Путь настоящий от начала до сети: служба, НАСТОЯЩИЙ прогон, фейковый CLI на
 * месте процесса, push и Telegram, собранные так же, как в `bootstrap/runtime.ts`,
 * и токен бота из зашифрованного хранилища во временной папке. Подменены только
 * внешние границы — процесс CLI и `fetch`: ни одно сообщение наружу не уходит.
 */

/** Фейковый CLI: печатает заданные куски и закрывается с кодом. */
/** Строка вывода gemini `-o stream-json` (0.62.0): так он печатает кусок ответа. */
const geminiOut = (text: string): string =>
  `${JSON.stringify({ type: 'message', role: 'assistant', content: text, delta: true })}
`;

function fakeSpawn(options: { chunks?: string[]; stderr?: string; code?: number; hang?: boolean }) {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: () => void; end: () => void; on: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    child.kill = () => child.emit('close', null);
    if (!options.hang) {
      setTimeout(() => {
        for (const chunk of options.chunks ?? []) child.stdout.emit('data', Buffer.from(chunk));
        if (options.stderr) child.stderr.emit('data', Buffer.from(options.stderr));
        child.emit('close', options.code ?? 0);
      }, 0);
    }
    return child;
  }) as unknown as Parameters<ProviderChatRun['start']>[0]['spawnImpl'];
}

interface Sent {
  url: string;
  body: unknown;
}

const BOT_TOKEN = '123456:secret-test-token';

describe('ProviderChatService: уведомления о конце хода', () => {
  let dir: string;
  let workdir: string;
  let sent: Sent[];
  let service: ProviderChatService;
  let events: TelegramEvent[];
  let pushOn: boolean;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-pchat-notify-'));
    workdir = join(dir, 'shop-front');
    mkdirSync(workdir);
    createChat(dir, 'gemini', { id: 'chat', workdir });
    writeToken(dir, 'telegram', BOT_TOKEN);
    sent = [];
    events = ['runDone', 'runError'];
    pushOn = true;
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      sent.push({ url: String(url), body: JSON.parse(String(init.body ?? 'null')) });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, data: [{ status: 'ok' }] }), { status: 200 }),
      );
    });

    // Сборка — та же, что в рантайме: push по устройствам и Telegram по подписке.
    const push = createRunNotifier({
      isEnabled: () => pushOn,
      devices: () => [
        { token: 'ExponentPushToken[test]', platform: 'android', label: '', registeredAt: '' },
      ],
      forget: () => {},
    });
    const telegram = createTelegramNotifier({
      settings: () => ({ enabled: true, chatId: '42', events }),
      token: () => readToken(dir, 'telegram'),
    });
    service = new ProviderChatService(() => new ProviderChatRun());
    service.setNotifier((notice) => {
      push(notice);
      telegram(notice);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const send = (spawnImpl: ReturnType<typeof fakeSpawn>): void => {
    const outcome = service.send(
      dir,
      'gemini',
      'chat',
      { text: 'Почини сборку' },
      { provider: getProvider('gemini'), detect: () => true, spawnImpl },
    );
    expect(outcome.ok).toBe(true);
  };

  const expo = (): Sent | undefined => sent.find((item) => item.url.includes('exp.host'));
  const bot = (): Sent | undefined => sent.find((item) => item.url.includes('api.telegram.org'));

  it('законченный ответ — «Работа закончена» в push и в Telegram', async () => {
    send(fakeSpawn({ chunks: [geminiOut('Готово')] }));

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const project = basename(workdir);
    expect(expo()?.body).toEqual([
      expect.objectContaining({
        to: 'ExponentPushToken[test]',
        title: 'Работа закончена',
        body: project,
        // Ключ связи с приставкой провайдера: голый id чужого чата неоднозначен.
        data: { kind: 'done', chatId: 'gemini:chat', projectPath: workdir },
      }),
    ]);
    expect(bot()?.body).toEqual({
      chat_id: '42',
      text: `✅ Работа закончена — ${project}`,
      disable_web_page_preview: true,
    });
    // Наружу уходит только заголовок: ни вопроса, ни ответа в теле нет.
    expect(JSON.stringify(sent)).not.toContain('Готово');
    expect(JSON.stringify(sent)).not.toContain('Почини сборку');
  });

  it('упавший ход — «Прогон упал»', async () => {
    send(fakeSpawn({ stderr: 'не найдена модель', code: 2 }));

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(expo()?.body).toEqual([expect.objectContaining({ title: 'Прогон упал' })]);
    expect(bot()?.body).toEqual(
      expect.objectContaining({ text: `⛔ Прогон упал — ${basename(workdir)}` }),
    );
    expect(JSON.stringify(sent)).not.toContain('не найдена модель');
  });

  it('подписка и выключатель — те же, что у Claude: неподписанное молчит', async () => {
    events = ['runError'];
    pushOn = false;
    send(fakeSpawn({ chunks: [geminiOut('Готово')] }));

    await vi.waitFor(() => expect(service.status('chat').isRunning).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
  });

  it('остановленный ход не уведомляет: его остановил тот, кто сидит у панели', async () => {
    send(fakeSpawn({ hang: true }));
    expect(service.stopByHuman('chat')).toBe(true);

    await vi.waitFor(() => expect(service.status('chat').isRunning).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
  });
});
