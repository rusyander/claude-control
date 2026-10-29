/**
 * Клиент-оракул на ответе не той формы (F-120): текст или пустое тело — провал с
 * протоколом, статусом и началом тела, а не голый SyntaxError/TypeError без контекста.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startStubModel, type StubModel } from '../index.mjs';
import { call } from './call.ts';

const open: StubModel[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((stub) => stub.close()));
});

const stubAnswering = async (status: number, body?: string) => {
  const stub = await startStubModel({
    route: ({ path }) => (path.endsWith('/chat/completions') ? { status, body } : undefined),
  });
  open.push(stub);
  return stub;
};

describe('call() on a reply that is not the protocol shape (F-120)', () => {
  it('text/plain body → names the dialect, the status and the body', async () => {
    const stub = await stubAnswering(502, 'bad gateway');
    await expect(call(stub.baseUrl, 'openai-chat', { text: 'x', stream: false })).rejects.toThrow(
      /openai-chat: HTTP 502 text\/plain.*not JSON.*bad gateway/,
    );
  });

  it('empty body (204) → names the status, no TypeError', async () => {
    const stub = await stubAnswering(204);
    await expect(call(stub.baseUrl, 'openai-chat', { text: 'x', stream: false })).rejects.toThrow(
      /openai-chat: HTTP 204 .*empty body/,
    );
  });

  it('media type is matched case-insensitively', async () => {
    const stub = await startStubModel({
      route: () => ({
        headers: { 'content-type': 'Text/Event-Stream' },
        body: 'data: [DONE]\n\n',
      }),
    });
    open.push(stub);
    // Поток разобран как SSE (провал протокола чата), а не как JSON.
    await expect(call(stub.baseUrl, 'openai-chat', { text: 'x', stream: true })).rejects.toThrow(
      /openai-chat stream: /,
    );
  });
});
