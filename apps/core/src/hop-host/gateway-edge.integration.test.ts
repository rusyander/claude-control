import { afterEach, describe, expect, it } from 'vitest';
import { hopStand, type HopStand } from './__fixtures__/hop-stand.ts';

/**
 * Перевод на краю шлюза звена (этап 10, план Q7): Responses (Codex) и Gemini API идут к
 * контуру OpenAI chat через настоящий хост звеньев; DLP судит переведённое тело верха, а
 * непереводимое уходит отказом до контура при любой маске.
 */

const j = (...parts: string[]): string => parts.join('');
const EMAIL = j('olga.sidorova', '@', 'corp-example', '.ru');

let stand: HopStand | undefined;
afterEach(async () => {
  await stand?.close().catch(() => undefined);
  stand = undefined;
});

async function post(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

const responsesBody = (text: string, extra: Record<string, unknown> = {}) => ({
  model: 'stub-model',
  input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
  stream: true,
  store: false,
  ...extra,
});

const googleBody = (text: string) => ({ contents: [{ role: 'user', parts: [{ text }] }] });

describe('шлюз звена: перевод Responses и Gemini на краю', () => {
  it('Responses → OpenAI chat: события Responses клиенту, наверху chat/completions', async () => {
    stand = await hopStand({ script: [{ text: ['edge ', 'answer'] }] });
    const reply = await stand.register({ from: 'openai-responses', to: 'openai-chat' });
    expect(reply.port).toBe(stand.host.ports.gateway);
    const answer = await post(
      reply.port,
      '/v1/responses',
      { authorization: `Bearer ${reply.placeholder}` },
      responsesBody('hi'),
    );
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('response.created');
    expect(answer.text).toContain('response.output_text.delta');
    expect(answer.text).toContain('edge ');
    expect(answer.text).toContain('response.completed');
    expect(stand.seen[0]?.path).toBe('/v1/chat/completions');
  });

  it('Responses с previous_response_id — 400 до контура, даже без маски', async () => {
    stand = await hopStand({ script: ['never'] });
    const reply = await stand.register({ from: 'openai-responses', to: 'openai-chat' });
    const answer = await post(
      reply.port,
      '/v1/responses',
      { authorization: `Bearer ${reply.placeholder}` },
      responsesBody('hi', { previous_response_id: 'resp_1' }),
    );
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('previous_response_id');
    expect(stand.seen).toHaveLength(0);
  });

  it('Q7: маска требуется — тело Responses маскируется ПОСЛЕ перевода, почты наверху нет', async () => {
    stand = await hopStand({ script: ['masked'] });
    const reply = await stand.register({
      from: 'openai-responses',
      to: 'openai-chat',
      dlp: { required: true, rulesHash: null },
    });
    const answer = await post(
      reply.port,
      '/v1/responses',
      { authorization: `Bearer ${reply.placeholder}` },
      responsesBody(`write to ${EMAIL}`),
    );
    expect(answer.status).toBe(200);
    expect(stand.seen).toHaveLength(1);
    expect(stand.seen[0]?.raw).toContain('"messages"');
    expect(stand.seen[0]?.raw).not.toContain(EMAIL);
  });

  it('Gemini → OpenAI chat: кадры Gemini потоком, ключ из x-goog-api-key, наверху chat/completions', async () => {
    stand = await hopStand({ script: [{ text: ['gem ', 'ini'] }] });
    const reply = await stand.register({ from: 'google-genai', to: 'openai-chat' });
    const answer = await post(
      reply.port,
      '/v1beta/models/stub-model:streamGenerateContent?alt=sse',
      { 'x-goog-api-key': reply.placeholder },
      googleBody('hi'),
    );
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('"candidates"');
    expect(answer.text).toContain('gem ');
    expect(stand.seen[0]?.path).toBe('/v1/chat/completions');
  });

  it('Gemini: :countTokens — оценка на месте, контура не касается; неизвестная метка — ошибка в форме Google', async () => {
    stand = await hopStand({ script: ['never'] });
    const reply = await stand.register({ from: 'google-genai', to: 'openai-chat' });
    const count = await post(
      reply.port,
      '/v1beta/models/stub-model:countTokens',
      { 'x-goog-api-key': reply.placeholder },
      googleBody('one two three'),
    );
    expect(count.status).toBe(200);
    expect((count.json as { totalTokens?: number }).totalTokens).toBeGreaterThan(0);
    const stranger = await post(
      reply.port,
      '/v1beta/models/stub-model:generateContent',
      { 'x-goog-api-key': 'adk-hop-unknown' },
      googleBody('hi'),
    );
    expect(stranger.status).toBe(401);
    expect((stranger.json as { error?: { status?: string } }).error?.status).toBeTypeOf('string');
    expect(stand.seen).toHaveLength(0);
  });

  it('Gemini с маской: почта уходит наверх замаскированной', async () => {
    stand = await hopStand({ script: ['masked'] });
    const reply = await stand.register({
      from: 'google-genai',
      to: 'openai-chat',
      dlp: { required: true, rulesHash: null },
    });
    const answer = await post(
      reply.port,
      '/v1beta/models/stub-model:generateContent',
      { 'x-goog-api-key': reply.placeholder },
      googleBody(`mail ${EMAIL}`),
    );
    expect(answer.status).toBe(200);
    expect(stand.seen).toHaveLength(1);
    expect(stand.seen[0]?.raw).not.toContain(EMAIL);
  });
});
