import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  composeWebhook,
  createWebhookNotifier,
  requireHttpUrl,
  sendWebhook,
  sign,
} from './webhook.ts';

/**
 * Вебхук: подписка, подпись и граница того, что уходит наружу.
 *
 * Сеть подменена. Проверяем ровно то, из-за чего вебхук опасен: он ходит на
 * ЧУЖОЙ адрес, и наружу не должно уехать ничего, кроме заголовка события.
 */

interface Sent {
  url: string;
  init: RequestInit;
}

function stub(status = 200): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    return Promise.resolve(new Response('{}', { status }));
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('domains/notify/webhook: адрес и подпись', () => {
  it('только http(s): прочая схема — 400 с именем поля', () => {
    expect(requireHttpUrl(' https://hooks.acme/x ')).toBe('https://hooks.acme/x');
    expect(() => requireHttpUrl('')).toThrow(expect.objectContaining({ detail: 'url' }));
    expect(() => requireHttpUrl('не адрес')).toThrow(expect.objectContaining({ detail: 'url' }));
    expect(() => requireHttpUrl('file:///c:/secret')).toThrow(
      expect.objectContaining({ detail: 'url' }),
    );
  });

  it('подпись считается по телу, а не по адресу', async () => {
    const sent = stub();
    const payload = composeWebhook({ kind: 'error', chatId: 'c1', projectPath: 'C:/work/panel' });
    await sendWebhook('https://hooks.acme/x', 'SEKRET', payload);

    const body = String(sent[0]!.init.body);
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers['X-AgentDeck-Signature']).toBe(
      createHmac('sha256', 'SEKRET').update(body).digest('hex'),
    );
    expect(sign('SEKRET', body)).toBe(headers['X-AgentDeck-Signature']);
  });

  it('без секрета подпись не приписывается', async () => {
    const sent = stub();
    await sendWebhook(
      'https://hooks.acme/x',
      undefined,
      composeWebhook({ kind: 'done', chatId: 'c1' }),
    );
    expect(sent[0]!.init.headers).not.toHaveProperty('X-AgentDeck-Signature');
  });

  it('отказ приёмника читается словами, а не молчанием', async () => {
    stub(503);
    await expect(
      sendWebhook(
        'https://hooks.acme/x',
        undefined,
        composeWebhook({ kind: 'done', chatId: 'c1' }),
      ),
    ).rejects.toThrow(/Вебхук/);
  });

  it('наружу уходит имя папки, а не путь проекта', () => {
    const payload = composeWebhook({
      kind: 'error',
      chatId: 'c1',
      projectPath: 'C:/work/secret-client/panel',
    });
    expect(payload.project).toBe('panel');
    expect(JSON.stringify(payload)).not.toContain('secret-client');
    expect(payload.event).toBe('runError');
  });
});

describe('domains/notify/webhook: подписка', () => {
  const settings = (over: Partial<Parameters<typeof createWebhookNotifier>[0]> = {}) =>
    createWebhookNotifier({
      settings: () => ({ enabled: true, url: 'https://hooks.acme/x', events: ['runError'] }),
      secret: () => undefined,
      ...over,
    });

  it('неподписанное событие не уходит вовсе', async () => {
    const sent = stub();
    settings()({ kind: 'done', chatId: 'c1' });
    await Promise.resolve();
    expect(sent).toHaveLength(0);
  });

  it('подписанное событие уходит телом с текстом', async () => {
    const sent = stub();
    settings()({ kind: 'error', chatId: 'c1', projectPath: 'C:/work/panel' });
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({
      event: 'runError',
      project: 'panel',
    });
  });

  it('выключенный вебхук и пустой адрес молчат без запроса', async () => {
    const sent = stub();
    createWebhookNotifier({
      settings: () => ({ enabled: false, url: 'https://hooks.acme/x', events: ['runError'] }),
      secret: () => undefined,
    })({ kind: 'error', chatId: 'c1' });
    createWebhookNotifier({
      settings: () => ({ enabled: true, url: '   ', events: ['runError'] }),
      secret: () => undefined,
    })({ kind: 'error', chatId: 'c1' });
    await Promise.resolve();
    expect(sent).toHaveLength(0);
  });

  it('упавшая отправка не роняет прогон — о ней сообщают колбэком', async () => {
    stub(500);
    const errors: unknown[] = [];
    createWebhookNotifier({
      settings: () => ({ enabled: true, url: 'https://hooks.acme/x', events: ['runError'] }),
      secret: () => undefined,
      onError: (error) => errors.push(error),
    })({ kind: 'error', chatId: 'c1' });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
  });
});
