import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelAgentConversation, PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_BRIDGE_ID } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { resetCliLookupCache } from '../../providers/detect.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { PANEL_AGENT_PROCESS_LEDGER } from '../../domains/panel-agent/processes.ts';
import { registerPanelAgentRunRoutes, type PanelAgentRunRouteDeps } from './run-routes.ts';

/**
 * F-101 D3: телефон на Android 15+ теряет сеть через секунды после ухода в фон,
 * поток хода рвётся — и ход агента панели умирал вместе с запросом. Ход с
 * `detach` переживает обрыв, клиент возвращается за кадрами по номеру.
 *
 * Настоящий маршрут на настоящем сокете (`listen` + `fetch` с обрывом), настоящий
 * запуск процесса, фальшивый `claude` на PATH — тот же, что у соседнего теста
 * маршрута: действие, пауза, ответ.
 */
const isWindows = process.platform === 'win32';

const FAKE = `
import { existsSync, readFileSync } from 'node:fs';
const SLOW_AFTER = new URL('./slow-after-ms.txt', import.meta.url);
for await (const _chunk of process.stdin) { /* ввод хода — не нужен */ }
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
out({ type: 'system', subtype: 'init' });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__${PANEL_AGENT_BRIDGE_ID}__where_am_i', input: {} }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: [{ type: 'text', text: 'Done.' }] }] } });
if (existsSync(SLOW_AFTER)) await new Promise((done) => setTimeout(done, Number(readFileSync(SLOW_AFTER, 'utf8'))));
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Вы в разделе проектов.' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Вы в разделе проектов.' });
`;

interface Frame {
  seq?: number;
  event: PanelAgentRunEvent;
}

/** Кадры SSE: `data:` и необязательный `id:` в любом порядке. */
function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .map((part) => {
      const lines = part.split('\n');
      const data = lines.find((line) => line.startsWith('data: '));
      const id = lines.find((line) => line.startsWith('id: '));
      if (!data) return undefined;
      return {
        ...(id ? { seq: Number(id.slice(4)) } : {}),
        event: JSON.parse(data.slice(6)) as PanelAgentRunEvent,
      };
    })
    .filter((frame): frame is Frame => frame !== undefined);
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('ход агента панели переживает обрыв (detach)', () => {
  let appData: string;
  let bin: string;
  let store: AppStore;
  let app: FastifyInstance;
  let base: string;
  const savedPath = process.env.PATH;

  const build = async (extra: Partial<PanelAgentRunRouteDeps> = {}): Promise<void> => {
    const ctx = { store, location: { paths: { appData } } } as unknown as ServerContext;
    app = Fastify();
    registerPanelAgentRunRoutes(app, ctx, {
      selfBaseUrl: 'http://127.0.0.1:5211',
      gatewayPort: () => 0,
      pending: new PanelPendingActions(10_000),
      ...extra,
    });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  };

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-detach-appdata-'));
    bin = mkdtempSync(join(tmpdir(), 'cc-agent-detach-bin-'));
    const script = join(bin, 'fake-claude.mjs');
    writeFileSync(script, FAKE, 'utf8');
    if (isWindows) {
      writeFileSync(
        join(bin, 'claude.cmd'),
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
      const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      process.env.PATH = `${bin}${delimiter}${system32}`;
    } else {
      writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        {
          mode: 0o755,
        },
      );
      process.env.PATH = `${bin}${delimiter}/usr/bin${delimiter}/bin`;
    }
    resetCliLookupCache();
    store = new AppStore(appData);
  });

  afterEach(async () => {
    await app.close();
    process.env.PATH = savedPath;
    resetCliLookupCache();
    rmSync(appData, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const body = (detach: boolean) => ({
    conversationId: 'conv-d',
    messages: [{ role: 'user', content: 'Где я?' }],
    context: { route: '/projects' },
    ...(detach ? { detach: true } : {}),
  });

  /** Начать ход, прочитать первые кадры и оборвать запрос, как ОС у телефона в фоне. */
  async function startAndDrop(detach: boolean): Promise<Frame[]> {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body(detach)),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    // До результата действия: ход идёт, ответа ещё нет (пауза фальшивого CLI).
    while (!parseFrames(text).some((frame) => frame.event.kind === 'tool-result')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);
    return parseFrames(text);
  }

  const ledger = () => {
    const path = join(appData, PANEL_AGENT_PROCESS_LEDGER);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown[]) : [];
  };
  const stored = () =>
    JSON.parse(
      readFileSync(join(appData, 'panel-agent', 'conv-d.json'), 'utf8'),
    ) as PanelAgentConversation;

  it('обрыв не снимает ход; вернувшийся клиент получает кадры после своего номера и ответ', async () => {
    writeFileSync(join(bin, 'slow-after-ms.txt'), '1500');
    await build();
    const seen = await startAndDrop(true);
    expect(seen.every((frame) => typeof frame.seq === 'number')).toBe(true);
    const last = seen.at(-1)!.seq!;
    await wait(300);
    expect(ledger()).toHaveLength(1); // процесс жив после обрыва

    const response = await fetch(`${base}/api/agent/run/conv-d/stream?fromSeq=${last}`);
    expect(response.status).toBe(200);
    const rest = parseFrames(await response.text());
    expect(rest[0]?.seq).toBe(last + 1);
    expect(rest.map((frame) => frame.event.kind)).toContain('done');
    expect(stored().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Вы в разделе проектов.',
    });
  });

  it('без detach обрыв снимает ход, как прежде, и кадры идут без номеров', async () => {
    writeFileSync(join(bin, 'slow-after-ms.txt'), '1500');
    await build();
    const seen = await startAndDrop(false);
    expect(seen.some((frame) => frame.seq !== undefined)).toBe(false);
    for (let i = 0; i < 100 && ledger().length > 0; i += 1) await wait(20);
    expect(ledger()).toEqual([]);
    expect((await fetch(`${base}/api/agent/run/conv-d/stream?fromSeq=0`)).status).toBe(404);
    expect(stored().messages.at(-1)?.content).not.toBe('Вы в разделе проектов.');
  });

  it('никто не вернулся за срок — ход снят сам', async () => {
    writeFileSync(join(bin, 'slow-after-ms.txt'), '4000');
    await build({ detachGraceMs: 200 });
    await startAndDrop(true);
    for (let i = 0; i < 100 && ledger().length > 0; i += 1) await wait(20);
    expect(ledger()).toEqual([]);
    expect(stored().messages.at(-1)?.content).not.toBe('Вы в разделе проектов.');
  });

  it('«Стоп» отцепленного хода — отдельным запросом', async () => {
    writeFileSync(join(bin, 'slow-after-ms.txt'), '4000');
    await build();
    await startAndDrop(true);
    const stop = await fetch(`${base}/api/agent/run/conv-d/stop`, { method: 'POST' });
    expect(stop.status).toBe(200);
    for (let i = 0; i < 100 && ledger().length > 0; i += 1) await wait(20);
    expect(ledger()).toEqual([]);
    expect((await fetch(`${base}/api/agent/run/conv-d/stop`, { method: 'POST' })).status).toBe(404);
  });

  it('законченный ход ещё отдаёт кадры опоздавшему; чужой разговор — 404', async () => {
    await build();
    await startAndDrop(true);
    for (let i = 0; i < 150 && ledger().length > 0; i += 1) await wait(20);
    const late = parseFrames(
      await (await fetch(`${base}/api/agent/run/conv-d/stream?fromSeq=0`)).text(),
    );
    expect(late[0]?.event.kind).toBe('start');
    expect(late.at(-1)?.event.kind).toBe('done');
    expect((await fetch(`${base}/api/agent/run/other/stream`)).status).toBe(404);
  });
});
