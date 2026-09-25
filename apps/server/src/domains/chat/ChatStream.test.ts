import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChatRunRegistry } from './ChatRunRegistry.ts';
import { streamRun } from './ChatStream.ts';

describe('streamRun', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  // Живой прогон 25.09: ответ в идущий разговор давал «отправлен» через 10 с —
  // заголовки уходили только с первым пингом. Настоящий сокет, а не inject:
  // inject ждёт конца ответа и задержки заголовков не видит вовсе.
  it('заголовки уходят сразу, даже когда прогон ещё молчит', async () => {
    const registry = {
      // Подписка есть, кадров нет: так выглядит отправка в занятый разговор.
      attach: () => () => undefined,
    } as unknown as ChatRunRegistry;
    app = Fastify();
    app.get('/stream', (_request, reply) => streamRun(registry, reply, 'чат', 0));
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2_000);
    const startedAt = Date.now();
    try {
      const response = await fetch(`${address}/stream`, { signal: abort.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  });
});

describe('кадр ошибки прогона', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  // Живой прогон 25.09: переполненный родитель показывал сырую строку API.
  // Кадр несёт код — карточка скажет словами интерфейса и даст выход.
  it('известная ошибка CLI уходит с кодом, параметрами и флагом переполнения', async () => {
    const message =
      'Prompt is too long · automatic compaction failed: API Error: 400 Claude Code 2.1.278 does ' +
      'not support this model; version 2.1.280 or newer is required.';
    const registry = {
      attach: (
        _chatId: string,
        _from: number,
        subscriber: import('./ChatRunRegistry.ts').RunSubscriber,
      ) => {
        subscriber.send({ seq: 1, event: { kind: 'error', message } });
        subscriber.close();
        return () => undefined;
      },
    } as unknown as ChatRunRegistry;
    app = Fastify();
    app.get('/stream', (_request, reply) => streamRun(registry, reply, 'чат', 0));

    const response = await app.inject({ method: 'GET', url: '/stream' });
    const data = response.body.split('\n').find((line) => line.startsWith('data: ')) ?? '';
    const frame = JSON.parse(data.slice('data: '.length));

    expect(frame).toMatchObject({
      kind: 'error',
      message,
      code: 'cli-outdated',
      params: { current: '2.1.278', required: '2.1.280' },
      overflow: true,
      retriable: false,
    });
  });

  // Живой прогон 25.09: сервер отдавал заголовки за 0,2 с, а через прокси Vite
  // ответ доходил с первым пингом через 10 с, и отправленный текст висел в поле.
  it('поток открывается комментарием до первого кадра — прокси отдают ответ сразу', async () => {
    const registry = {
      attach: (
        _chatId: string,
        _from: number,
        subscriber: import('./ChatRunRegistry.ts').RunSubscriber,
      ) => {
        subscriber.close();
        return () => undefined;
      },
    } as unknown as ChatRunRegistry;
    app = Fastify();
    app.get('/stream', (_request, reply) => streamRun(registry, reply, 'чат', 0));

    const response = await app.inject({ method: 'GET', url: '/stream' });

    expect(response.body.startsWith(': open\n\n')).toBe(true);
  });
});
