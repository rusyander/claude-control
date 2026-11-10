import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushDevice } from '@agentdeck/contracts';
import type { RelayNotice } from '@agentdeck/contracts/core/relay';
import {
  createPushOnce,
  createRunNotifier,
  EXPO_PUSH_URL_ENV,
  sendExpoPush,
} from '../remote-notify.ts';
import { createCoreAskDelivery } from './core-ask-delivery.ts';

/**
 * Push на телефон только о том, что ЖДЁТ человека (этап 12, P175), и один push на вопрос (askId)
 * на оба отправителя — уведомитель прогонов чата и пересылку вопросов ядра. Путь настоящий:
 * `createRunNotifier` и `createCoreAskDelivery` с общим `createPushOnce`, отправка — настоящий
 * `sendExpoPush` по сети в поддельный сервис Expo на loopback (`AGENTDECK_EXPO_PUSH_URL`); подменён
 * только адрес сервиса.
 */

interface ExpoBody {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

const TASK = '019a0000-0000-7000-8000-000000000001';
const ASK = '019a0000-0000-7000-8000-0000000000a1';
const ASK_2 = '019a0000-0000-7000-8000-0000000000a2';

const device: PushDevice = {
  token: 'ExponentPushToken[once]',
  platform: 'android',
  label: 'phone',
  registeredAt: '2026-11-01T00:00:00Z',
};

let server: Server;
let received: ExpoBody[];

beforeEach(async () => {
  received = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const messages = JSON.parse(raw) as ExpoBody[];
      received.push(...messages);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: messages.map(() => ({ status: 'ok' })) }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  vi.stubEnv(EXPO_PUSH_URL_ENV, `http://127.0.0.1:${port}/--/api/v2/push/send`);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((done) => server.close(() => done()));
});

/** Оба отправителя с ОДНИМ журналом push — как их собирает `bootstrap/runtime/notify-wiring.ts`. */
function senders() {
  const once = createPushOnce();
  const notify = createRunNotifier({
    isEnabled: () => true,
    devices: () => [device],
    forget: () => undefined,
    machineId: () => 'machine-0001',
    once,
  });
  const relay = createCoreAskDelivery({
    // Telegram выключен: здесь видно только push.
    telegram: () => ({ enabled: false, chatId: '', events: [] }),
    token: () => undefined,
    answersCover: () => false,
    sentLog: { record: () => undefined } as never,
    pushEnabled: () => true,
    devices: () => [device],
    machineId: () => 'machine-0001',
    push: (messages) => sendExpoPush(messages, () => undefined),
    pushOnce: once,
    log: () => undefined,
  });
  return { notify, relay };
}

const notice = (askId: string): RelayNotice => ({
  taskId: TASK,
  askId,
  kind: 'ask',
  title: 'Починить вход',
  deepLink: `http://127.0.0.1:8888/core?id=${TASK}&ask=${askId}`,
});

/** Отправка уведомителя идёт фоном: дождаться, пока сервис Expo получит `count` сообщений. */
async function arrived(count: number): Promise<void> {
  await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(count));
  // Лишнее пришло бы следом — короткая пауза ловит второй запрос, если он был.
  await new Promise((done) => setTimeout(done, 50));
}

describe('push only for what waits, one push per askId across notifier and relay', () => {
  it('done and error never reach Expo; permission and question do; the settings test push goes', async () => {
    const { notify } = senders();
    notify({ kind: 'done', chatId: 'c1', projectPath: '/work/app' });
    notify({ kind: 'error', chatId: 'c1', projectPath: '/work/app' });
    notify({ kind: 'permission', chatId: 'c1', projectPath: '/work/app', toolName: 'Bash' });
    notify({ kind: 'question', chatId: 'c2' });
    notify({ kind: 'done', chatId: 'test', test: true });
    await arrived(3);
    expect(received.map((m) => m.data.kind)).toEqual(['permission', 'question', 'test']);
    expect(received.map((m) => m.title)).not.toContain('Работа закончена');
    expect(received.map((m) => m.title)).not.toContain('Прогон упал');
  });

  it('chat card of a core ask first, relay second → one push; relay first, chat card second → one push', async () => {
    const first = senders();
    first.notify({ kind: 'permission', chatId: 'c1', toolName: 'agentdeck', askId: ASK });
    await arrived(1);
    // Пересылка о том же вопросе: человек уже знает — сообщено, но второго push нет.
    expect(await first.relay.deliver(notice(ASK), 'Разрешить правку?', true)).toBe(true);
    await arrived(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.data).toMatchObject({ kind: 'permission', chatId: 'c1' });

    received = [];
    const second = senders();
    expect(await second.relay.deliver(notice(ASK), 'Разрешить правку?', true)).toBe(true);
    second.notify({ kind: 'permission', chatId: 'c1', toolName: 'agentdeck', askId: ASK });
    await arrived(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.data).toMatchObject({ kind: 'core-ask', taskId: TASK, askId: ASK });
  });

  it('two asks of one chat → two pushes: the key is the askId, not the chat', async () => {
    const { notify, relay } = senders();
    notify({ kind: 'permission', chatId: 'c1', toolName: 'agentdeck', askId: ASK });
    notify({ kind: 'permission', chatId: 'c1', toolName: 'agentdeck', askId: ASK_2 });
    await arrived(2);
    expect(received).toHaveLength(2);
    // Тот же вопрос второй раз (повтор карточки) — ничего.
    notify({ kind: 'permission', chatId: 'c1', toolName: 'agentdeck', askId: ASK });
    expect(await relay.deliver(notice(ASK_2), 'q', true)).toBe(true);
    await arrived(2);
    expect(received).toHaveLength(2);
  });

  it('a non-blocking core ask → no push at all (nothing waits for the human)', async () => {
    const { relay } = senders();
    expect(relay.ready(false)).toBe(false);
    expect(await relay.deliver(notice(ASK), 'Продолжаю с умолчанием', false)).toBe(false);
    expect(relay.ready(true)).toBe(true);
    expect(await relay.deliver(notice(ASK_2), 'Ждёт ответа', true)).toBe(true);
    await arrived(1);
    expect(received.map((m) => m.data.askId)).toEqual([ASK_2]);
  });
});
