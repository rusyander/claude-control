/**
 * След не хранит значений доступа ни в адресе, ни в теле (F-78): раньше `client_secret`,
 * `refresh_token` в строке запроса и `api_key` в теле писались в файл как есть, а адрес
 * пересобирался целиком (`%20` → `+`, метка «есть» — `%3Cpresent%3E`).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PRESENT, startStubModel, type StubModel } from './index.mjs';
import { call } from './clients/call.ts';

const dir = mkdtempSync(join(tmpdir(), 'stub-model-redact-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open: StubModel[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((stub) => stub.close()));
});

const traced = (file: string) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('trace redaction (F-78)', () => {
  it('query: every credential-named parameter hidden, the rest kept byte for byte', async () => {
    const trace = join(dir, 'query.jsonl');
    const stub = await startStubModel({ trace });
    open.push(stub);
    const query =
      'q=a%20b&flag&client_secret=Q1&refresh_token=Q2&x-goog-api-key=Q3&sig=Q4&auth=Q5&key=Q6&password=Q7';
    await fetch(`${stub.baseUrl}/v1/models?${query}`);
    const text = readFileSync(trace, 'utf8');
    for (const secret of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'])
      expect(text).not.toContain(secret);
    expect(traced(trace)[0]!.path).toBe(
      `/v1/models?q=a%20b&flag&client_secret=${PRESENT}&refresh_token=${PRESENT}` +
        `&x-goog-api-key=${PRESENT}&sig=${PRESENT}&auth=${PRESENT}&key=${PRESENT}&password=${PRESENT}`,
    );
  });

  it('body: credential-named fields hidden at any depth; token counts and content kept', async () => {
    const trace = join(dir, 'body.jsonl');
    const stub = await startStubModel({ trace });
    open.push(stub);
    await fetch(`${stub.baseUrl}/v1/unknown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: 'B1',
        nested: { client_secret: 'B2', refreshToken: 'B3', list: [{ password: 'B4' }] },
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    await fetch(`${stub.baseUrl}/v1/unknown`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh&client_secret=F1&refresh_token=F2',
    });
    const text = readFileSync(trace, 'utf8');
    for (const secret of ['B1', 'B2', 'B3', 'B4', 'F1', 'F2']) expect(text).not.toContain(secret);
    const [json, form] = traced(trace);
    expect(json!.body).toEqual({
      api_key: PRESENT,
      nested: { client_secret: PRESENT, refreshToken: PRESENT, list: [{ password: PRESENT }] },
      max_tokens: 5,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(form!.body).toBe(`grant_type=refresh&client_secret=${PRESENT}&refresh_token=${PRESENT}`);
  });

  it('a model request body is redacted in the trace, kept whole in requests[] for the script', async () => {
    const trace = join(dir, 'model.jsonl');
    const stub = await startStubModel({
      trace,
      script: { rules: [{ when: 'M1', step: 'saw it' }] },
    });
    open.push(stub);
    const outcome = await call(stub.baseUrl, 'openai-chat', { text: 'x', stream: false });
    expect(outcome.status).toBe(200);
    await fetch(`${stub.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        api_key: 'M1',
      }),
    });
    expect(readFileSync(trace, 'utf8')).not.toContain('M1');
    expect(stub.requests[1]!.raw).toContain('M1');
    expect(stub.requests[1]!.reply).toBe('saw it');
  });
});
