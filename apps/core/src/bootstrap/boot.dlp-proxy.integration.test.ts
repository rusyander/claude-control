import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreDlpProxyReply } from '@agentdeck/contracts/core/hops';
import { startStubModel, type RouteRequest, type StubModel } from '@agentdeck/stub-model';
import { startHopHost, type RunningHopHost } from '../hop-host/host.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Прокси защиты данных человека на НАСТОЯЩЕЙ загрузке ядра (C3c, перенос `DlpProxy` панели):
 * настройки и правила — в каталоге данных панели (временный), слушатель — на настоящем хосте
 * звеньев, верх — `@agentdeck/stub-model`. CLI человека шлёт тело с почтой и своим ключом:
 * модель видит метку и тот же ключ, CLI получает ответ с почтой обратно; журнал — у панели.
 */

const j = (...parts: string[]): string => parts.join('');
const EMAIL = j('olga.sidorova', '@', 'corp-example', '.ru');
const OWN_KEY = j('sk-', 'cli-own', '-0123456789');
const STOP_WORD = j('проект', '-', 'буран');

let stub: StubModel;
let core: BootedCore | undefined;
let host: RunningHopHost;
let appData: string;
let port: number;
let auth: Record<string, string>;
const seen: RouteRequest[] = [];

const RULES = [
  { id: 'mail', name: 'Почта', kind: 'builtin', builtin: 'email', action: 'mask', label: 'ПОЧТА' },
  { id: 'stop', name: 'Стоп-слово', kind: 'terms', terms: [STOP_WORD], action: 'block' },
];

function writeSettings(dlp: Record<string, unknown>): void {
  writeFileSync(join(appData, 'state.json'), JSON.stringify({ settings: { dlp } }));
}

function writeRules(rules: unknown[]): void {
  writeFileSync(join(appData, 'dlp-rules.json'), JSON.stringify({ version: 1, rules }));
}

const placeholderIn = (raw: string): string => /\[ПОЧТА_\d+\]/.exec(raw)?.[0] ?? 'NO-PLACEHOLDER';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen({ host: '127.0.0.1', port: 0 }, () => done()));
  const { port: free } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return free;
}

async function cli(path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': OWN_KEY },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function api(path: string, method = 'GET'): Promise<CoreDlpProxyReply> {
  const response = await fetch(`${core!.url}${path}`, { method, headers: auth });
  expect(response.status).toBe(200);
  return (await response.json()) as CoreDlpProxyReply;
}

const messages = (text: string, stream = false) => ({
  model: 'stub-model',
  max_tokens: 64,
  ...(stream ? { stream: true } : {}),
  messages: [{ role: 'user', content: text }],
});

beforeAll(async () => {
  stub = await startStubModel({
    route: (request) => {
      if (request.path.endsWith('/models')) return undefined;
      seen.push(request);
      const echo = `ответ про ${placeholderIn(request.raw)}`;
      if (request.body?.stream === true)
        return {
          sse: {
            frames: [
              {
                event: 'message_start',
                data: {
                  type: 'message_start',
                  message: {
                    id: 'm1',
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: 'stub-model',
                    usage: { input_tokens: 3, output_tokens: 0 },
                  },
                },
              },
              {
                event: 'content_block_start',
                data: {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: '' },
                },
              },
              {
                event: 'content_block_delta',
                data: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: echo },
                },
              },
              { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
              { event: 'message_stop', data: { type: 'message_stop' } },
            ],
          },
        };
      return {
        body: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          model: 'stub-model',
          content: [{ type: 'text', text: echo }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 3 },
        },
      };
    },
  });
  appData = tempDir('dlpx-panel-');
  port = await freePort();
  writeRules(RULES);
  writeSettings({ enabled: true, port, upstreamUrl: stub.baseUrl, journal: true });
  const home = join(tempDir('dlpx-core-'), 'core');
  host = await startHopHost({ home, panelAppData: appData, retryPauseMs: 10 });
  core = await bootCore({
    home,
    build: 'dlpx-test',
    panelAppData: appData,
    loop: false,
    dlpProxy: { intervalMs: 60_000 },
  });
  auth = { authorization: `Bearer ${readFileSync(core.layout.token, 'utf8').trim()}` };
}, 60_000);

afterAll(async () => {
  await core?.stop().catch(() => undefined);
  await host?.close();
  await stub?.close();
});

describe('прокси защиты данных человека: слушатель хоста звеньев по настройкам панели', () => {
  it('тумблер включён — прокси слушает порт из настроек, адрес наверх из настроек', async () => {
    const state = await api('/v1/dlp-proxy/apply', 'POST');
    expect(state.problem).toBeNull();
    expect(state.proxy?.state).toBe('listening');
    expect(state.proxy?.port).toBe(port);
    expect(state.proxy?.upstream).toBe(stub.baseUrl.replace(/\/+$/, ''));
  });

  it('почта уходит модели меткой, ключ CLI — как есть; ответ возвращается с почтой', async () => {
    const reply = await cli('/v1/messages', messages(`напиши ${EMAIL}`));
    expect(reply.status).toBe(200);
    const upstream = seen.at(-1)!;
    expect(upstream.raw).not.toContain(EMAIL);
    expect(upstream.raw).toMatch(/\[ПОЧТА_\d+\]/);
    expect(JSON.stringify(upstream.headers)).toContain(OWN_KEY);
    expect(reply.text).toContain(EMAIL);
    expect(reply.text).not.toMatch(/\[ПОЧТА_\d+\]/);
  });

  it('поток: метка в кадре ответа разворачивается до CLI', async () => {
    const reply = await cli('/v1/messages', messages(`ещё раз ${EMAIL}`, true));
    expect(reply.status).toBe(200);
    expect(seen.at(-1)!.raw).not.toContain(EMAIL);
    expect(reply.text).toContain(EMAIL);
    expect(reply.text).not.toMatch(/\[ПОЧТА_\d+\]/);
  });

  it('правило «блок» — отказ в форме API без похода к модели; незнакомая форма — отказ', async () => {
    const before = seen.length;
    const blocked = await cli('/v1/messages', messages(`план ${STOP_WORD}`));
    expect(blocked.status).toBe(400);
    expect(blocked.text).toContain('invalid_request_error');
    expect(blocked.text).toContain('Стоп-слово');
    const unknown = await cli('/v1/strange', { what: EMAIL });
    expect(unknown.status).toBe(400);
    expect(seen.length).toBe(before);
  });

  it('журнал панели: решения и правила без значений; счётчики прокси в ответе ядра', async () => {
    const journal = readFileSync(join(appData, 'dlp-journal.jsonl'), 'utf8');
    expect(journal).not.toContain(EMAIL);
    expect(journal).not.toContain(STOP_WORD);
    const decisions = journal
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { decision: string }).decision);
    expect(decisions).toEqual(['masked', 'masked', 'blocked', 'blocked']);
    const state = await api('/v1/dlp-proxy');
    expect(state.proxy).toMatchObject({ requests: 4, masked: 2, blocked: 2 });
  });

  it('«пропускать неразобранное» — незнакомая форма уходит как есть и попадает в журнал', async () => {
    writeSettings({ enabled: true, port, upstreamUrl: stub.baseUrl, passUnknown: true });
    await api('/v1/dlp-proxy/apply', 'POST');
    const passed = await cli('/v1/strange', { what: 'x' });
    expect(passed.status).toBe(200);
    expect(seen.at(-1)!.path).toBe('/v1/strange');
    const last = readFileSync(join(appData, 'dlp-journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .at(-1)!;
    expect(JSON.parse(last)).toMatchObject({ decision: 'passed', path: '/v1/strange' });
  });

  it('без включённого правила или без адреса наверх — прокси не открыт, причина названа', async () => {
    writeRules(RULES.map((rule) => ({ ...rule, enabled: false })));
    const noRules = await api('/v1/dlp-proxy/apply', 'POST');
    expect(noRules.proxy).toBeNull();
    expect(noRules.problem?.code).toBe('dlp-no-rules');
    await expect(cli('/v1/messages', messages(EMAIL))).rejects.toThrow();
    writeRules(RULES);
    writeSettings({ enabled: true, port });
    const noUpstream = await api('/v1/dlp-proxy/apply', 'POST');
    expect(noUpstream.problem?.code).toBe('dlp-upstream-missing');
    expect(noUpstream.proxy).toBeNull();
  });

  it('тумблер выключен — порт закрыт, причины нет', async () => {
    writeSettings({ enabled: true, port, upstreamUrl: stub.baseUrl });
    expect((await api('/v1/dlp-proxy/apply', 'POST')).proxy?.state).toBe('listening');
    writeSettings({ enabled: false, port, upstreamUrl: stub.baseUrl });
    const off = await api('/v1/dlp-proxy/apply', 'POST');
    expect(off).toMatchObject({ enabled: false, proxy: null, problem: null });
    await expect(cli('/v1/messages', messages(EMAIL))).rejects.toThrow();
  });
});
