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
