import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DECK_JSON,
  REWRITTEN_FINAL,
  SCENARIOS,
  startContourStub,
  type ContourStub,
} from './contour.mjs';

/**
 * Сценарий «стаб-контур» над сервером пакета (P120): провод тот же, что разбирают свипы
 * панели и маршрут шлюза ядра, — каталог трёх форм, отказы, вендорные кадры, агенты.
 */

let stub: ContourStub;
let renamed: ContourStub;

beforeAll(async () => {
  stub = await startContourStub({ port: 0 });
  renamed = await startContourStub({ vendorPrefix: 'acme', delayMs: 1 });
});
afterAll(async () => {
  await stub.close();
  await renamed.close();
});

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** Данные кадров потока: `[DONE]` строкой, остальное JSON. */
async function frames(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length))
    .map((data) => (data === '[DONE]' ? data : JSON.parse(data)));
}

const chat = (model: string, extra: Record<string, unknown> = {}, base = stub.url) =>
  post(base, '/v1/chat/completions', { model, messages: [], ...extra });

const content = (all: unknown[]): string =>
  all
    .map((f) => (f as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta)
    .map((d) => (typeof d?.content === 'string' ? d.content : ''))
    .join('');

describe('stub-model scenarios/contour', () => {
  it('catalog: openai list, together bare array, openrouter priced only for stub-chat', async () => {
    const plain = (await (await fetch(`${stub.url}/v1/models`)).json()) as {
      data: { id: string }[];
    };
    expect(plain.data.map((m) => m.id)).toContain('stub-451');
    const together = (await (await fetch(`${stub.url}/together/v1/models`)).json()) as unknown[];
    expect(together[0]).toEqual({ id: 'stub-chat', type: 'chat', context_length: 128000 });
    const router = (await (await fetch(`${stub.url}/openrouter/v1/models`)).json()) as {
      data: { id: string; pricing: { prompt: string } }[];
    };
    expect(router.data.find((m) => m.id === 'stub-chat')?.pricing.prompt).toBe('1');
    expect(router.data.find((m) => m.id === 'stub-402')?.pricing.prompt).toBe('-1');
  });

  it('refusals by model name before any stream, 429 carries retry-after', async () => {
    for (const code of ['401', '402', '429', '451', '503']) {
      const response = await chat(`stub-${code}`, { stream: true });
      expect(response.status).toBe(Number(code));
      expect(response.headers.get('content-type')).toContain('application/json');
    }
    expect((await chat('stub-429')).headers.get('retry-after')).toBe('12');
    const budget = (await (await chat('stub-402')).json()) as { error: { message: string } };
    expect(budget.error.message).toBe('budget exceeded for this API key');
  });

  it('clean stream: stages first, then text, stop, usage beside a non-empty choices, [DONE]', async () => {
    const all = await frames(await chat('stub-chat', { stream: true }));
    expect(all[0]).toEqual({ platform_status: 'guardrails_input' });
    expect(all[1]).toEqual({ platform_status: 'inference' });
    expect(content(all)).toBe('готов');
    expect(all.at(-1)).toBe('[DONE]');
    const usage = all.at(-2) as { choices: unknown[]; usage: { prompt_tokens: number } };
    expect(usage.choices).toHaveLength(1);
    expect(usage.usage.prompt_tokens).toBe(11);
  });

  it.each([
    ['summarizing', { platform_status: 'summarizing' }],
    ['reasoning', { platform_reasoning: 'сначала посчитаю' }],
    ['tools', { platform_tools_unavailable: true }],
    ['rewritten', { platform_deanonymized: REWRITTEN_FINAL }],
  ])('vendor frame of %s', async (scenario, expected) => {
    expect(await frames(await chat(`stub-${scenario}`, { stream: true }))).toContainEqual(expected);
  });

  it('masked and anonymized frames; guardrails stream ends without stop or [DONE]', async () => {
    const masked = await frames(await chat('stub-masked', { stream: true }));
    expect(JSON.stringify(masked)).toContain('platform_sanitized');
    const anon = await frames(await chat('stub-anonymized', { stream: true }));
    expect(JSON.stringify(anon)).toContain('platform_deanonymized_entities');
    const cut = await frames(await chat('stub-guardrails', { stream: true }));
    expect(cut.at(-1)).toMatchObject({ platform_guardrails: { stream_interrupted: true } });
    expect(cut).not.toContain('[DONE]');
  });

  it('stream-error: error object after 200 headers, no [DONE]; image: no usage frame', async () => {
    const failed = await frames(await chat('stub-stream-error', { stream: true }));
    expect(failed.at(-1)).toMatchObject({ error: { code: 'rate_limit_exceeded' } });
    const image = await frames(await chat('stub-image', { stream: true }));
    expect(JSON.stringify(image)).toContain('data:image/png;base64,');
    expect(image.some((f) => typeof f === 'object' && f !== null && 'usage' in f)).toBe(false);
  });

  it('deck arrives in two chunks that join into the fenced block', async () => {
    const all = await frames(await chat('stub-deck', { stream: true }));
    expect(content(all)).toBe(['```agentdeck:deck', JSON.stringify(DECK_JSON), '```'].join('\n'));
    const whole = (await (await chat('stub-deck')).json()) as { usage: { total_tokens: number } };
    expect(whole.usage.total_tokens).toBe(51);
  });

  it('tool-shim: call on the first turn, text once its own mark is in the history', async () => {
    const ask = { messages: [{ role: 'user', content: 'ФАЙЛ: /tmp/a.txt' }] };
    const first = content(await frames(await chat('stub-tool-shim', { stream: true, ...ask })));
    expect(first).toContain('<tool_call>');
    expect(first).toContain('/tmp/a.txt');
    const second = await chat('stub-tool-shim', {
      messages: [...ask.messages, { role: 'assistant', content: first }],
    });
    expect(
      ((await second.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message
        .content,
    ).toBe('файл создан по протоколу');
  });

  it('tool-loose / tool-any count turns; tool-quote never changes; tool-tail tail after stop', async () => {
    const loose = { messages: [{ role: 'user', content: 'ФАЙЛ: /tmp/loose-1.txt' }] };
    expect(
      content(await frames(await chat('stub-tool-loose', { stream: true, ...loose }))),
    ).toMatch(/^```/);
    expect(content(await frames(await chat('stub-tool-loose', { stream: true, ...loose })))).toBe(
      'файл создан по протоколу',
    );
    const any = { messages: [{ role: 'user', content: "ВЫЗОВ: {'name':'Bash'};;" }] };
    expect(content(await frames(await chat('stub-tool-any', { stream: true, ...any })))).toBe(
      '<tool_call>{"name":"Bash"}</tool_call>',
    );
    expect(content(await frames(await chat('stub-tool-any', { stream: true, ...any })))).toBe(
      'вызов отработан',
    );
    expect(content(await frames(await chat('stub-tool-any', { stream: true })))).toBe(
      'в задании нет вызова',
    );
    expect(content(await frames(await chat('stub-tool-quote', { stream: true })))).toContain(
      'не выполняй',
    );
    const tail = await frames(await chat('stub-tool-tail', { stream: true }));
    const stopAt = tail.findIndex((f) => JSON.stringify(f).includes('"finish_reason":"stop"'));
    expect(content(tail.slice(stopAt))).toBe('"}}</tool_call>');
  });

  it('tool-native: declared Write → field call in two pieces; probe; nothing declared; tool role', async () => {
    const write = { tools: [{ type: 'function', function: { name: 'Write' } }] };
    const call = await frames(await chat('stub-tool-native', { stream: true, ...write }));
    expect(JSON.stringify(call)).toContain('"finish_reason":"tool_calls"');
    const whole = (await (await chat('stub-tool-native', write)).json()) as {
      choices: { message: { tool_calls: { function: { name: string } }[] } }[];
    };
    expect(whole.choices[0]!.message.tool_calls[0]!.function.name).toBe('Write');
    const probe = (await (
      await chat('stub-tool-native', { tools: [{ function: { name: 'report_status' } }] })
    ).json()) as { choices: { message: { tool_calls: { id: string }[] } }[] };
    expect(probe.choices[0]!.message.tool_calls[0]!.id).toBe('call_native_probe');
    expect(content(await frames(await chat('stub-tool-native', { stream: true })))).toBe(
      'инструментов мне не объявили',
    );
    const done = (await (
      await chat('stub-tool-native', { messages: [{ role: 'tool', content: 'ok' }] })
    ).json()) as { choices: { message: { content: string } }[] };
    expect(done.choices[0]!.message.content).toBe('файл создан полем');
  });

  it('whole bodies carry vendor verdicts; image without usage', async () => {
    for (const [model, field] of [
      ['stub-tools', 'platform_tools_unavailable'],
      ['stub-masked', 'platform_sanitized'],
      ['stub-guardrails', 'platform_guardrails'],
    ] as const) {
      expect(await (await chat(model)).json()).toHaveProperty(field);
    }
    expect(await (await chat('stub-image')).json()).not.toHaveProperty('usage');
  });

  it('vendor prefix renames vendor fields in stream and body; delay still delivers', async () => {
    const all = await frames(await chat('stub-tools', { stream: true }, renamed.url));
    expect(all).toContainEqual({ acme_status: 'inference' });
    expect(await (await chat('stub-tools', {}, renamed.url)).json()).toHaveProperty(
      'acme_tools_unavailable',
      true,
    );
  });

  it('single_turn: stream → 400 of the platform schema, whole → named tool call', async () => {
    const refused = await chat('stub-chat', { stream: true, platform_tool_mode: 'single_turn' });
    expect(refused.status).toBe(400);
    const single = (await (
      await chat('stub-chat', { platform_tool_mode: 'single_turn', platform_tools: ['fetch'] })
    ).json()) as { choices: { message: { tool_calls: { function: { name: string } }[] } }[] };
    expect(single.choices[0]!.message.tool_calls[0]!.function.name).toBe('fetch');
    const fallback = (await (
      await chat('stub-chat', { platform_tool_mode: 'single_turn' })
    ).json()) as { choices: { message: { tool_calls: { function: { name: string } }[] } }[] };
    expect(fallback.choices[0]!.message.tool_calls[0]!.function.name).toBe('web_search');
  });

  it('images: picture by default, refusal by a word in the prompt', async () => {
    const ok = (await (
      await post(stub.url, '/v1/images/generations', { prompt: 'кот' })
    ).json()) as {
      data: { b64_json: string }[];
    };
    expect(ok.data[0]!.b64_json.length).toBeGreaterThan(10);
    expect(
      (await post(stub.url, '/v1/images/generations', { prompt: 'stub-451 кот' })).status,
    ).toBe(451);
  });

  it('published agents echo and keep a session; delete forgets it; embeddings by length', async () => {
    const reply = (await (
      await post(stub.url, '/v1/agent/completions', {
        agent: 'a1',
        session: 's1',
        messages: [{ role: 'user', content: 'привет' }],
      })
    ).json()) as { choices: { message: { content: string } }[]; session_recorded: boolean };
    expect(reply.choices[0]!.message.content).toBe('a1: привет');
    expect(reply.session_recorded).toBe(true);
    await post(stub.url, '/v1/agent/completions', { agent: 'a2', session: 's1', messages: [] });
    const filtered = (await (await fetch(`${stub.url}/v1/agent/sessions/s1?agent=a1`)).json()) as {
      sessions: { agent_id: string }[];
    };
    expect(filtered.sessions.map((s) => s.agent_id)).toEqual(['a1']);
    await fetch(`${stub.url}/v1/agent/sessions/s1`, { method: 'DELETE' });
    expect(await (await fetch(`${stub.url}/v1/agent/sessions/s1`)).json()).toEqual({
      sessions: [],
    });
    const vectors = (await (
      await post(stub.url, '/v1/embeddings', { model: 'stub-embed', input: ['abc', 'de'] })
    ).json()) as { data: { embedding: number[] }[] };
    expect(vectors.data.map((v) => v.embedding[0])).toEqual([3, 2]);
    const single = (await (await post(stub.url, '/v1/embeddings', { input: 'x' })).json()) as {
      data: unknown[];
    };
    expect(single.data).toHaveLength(1);
  });

  it('native anthropic /messages answers through the package dialect; call trace records headers', async () => {
    const response = await post(
      stub.url,
      '/v1/messages',
      { model: 'stub-chat', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      { 'anthropic-version': '2023-06-01', 'api-key': 'k', 'x-tenant': 't' },
    );
    const message = (await response.json()) as { content: { text: string }[]; usage: unknown };
    expect(message.content[0]!.text).toBe('ответ родной ручки');
    expect(message.usage).toMatchObject({ input_tokens: 11, output_tokens: 5 });
    const seen = stub.calls.find((c) => c.path === '/v1/messages');
    expect(seen).toMatchObject({ anthropicVersion: '2023-06-01', apiKey: 'k', tenant: 't' });
  });

  it('unknown path → 404 named; scenario list is the documented one', async () => {
    expect((await fetch(`${stub.url}/v1/unknown`)).status).toBe(404);
    expect(SCENARIOS.has('tool-native')).toBe(true);
  });
});
