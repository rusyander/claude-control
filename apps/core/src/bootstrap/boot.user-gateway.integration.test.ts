import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HopControlReply } from '@agentdeck/contracts/core/hops';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { startStubModel, type RouteRequest, type StubModel } from '@agentdeck/stub-model';
import { anthropicBody } from '../hop-host/__fixtures__/hop-stand.ts';
import { startHopHost, type RunningHopHost } from '../hop-host/host.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readToken } from '../platform/token-file.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { userGatewayPortOf } from './user-gateway-wiring.ts';

/**
 * Шлюз человека на НАСТОЯЩЕЙ загрузке ядра (этап 10): контуры — из каталога данных панели
 * (временный), ключ контура — в её зашифрованном хранилище, хост звеньев настоящий, верх —
 * `@agentdeck/stub-model`. Прежний шлюз в панели изображает чужой слушатель на том же порту:
 * ядро ждёт, берёт порт, как только его отпустили, и CLI человека ходит по тому же адресу.
 */

const j = (...parts: string[]): string => parts.join('');
const CONTOUR_KEY = j('sk-', 'contour', '-ugw-0123456789');
const EMAIL = j('olga.sidorova', '@', 'corp-example', '.ru');

let stub: StubModel;
let core: BootedCore | undefined;
let host: RunningHopHost;
let appData: string;
let foreign: Server;
let port: number;
const seen: RouteRequest[] = [];

const contour = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Контур ${id}`,
  driver: 'litellm',
  baseUrl: stub.baseUrl,
  enabled: true,
  ...extra,
});

function writeState(platforms: unknown[]): void {
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({ settings: { dlp: { enabled: true }, platforms } }),
  );
}

async function call(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'cli-placeholder', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

beforeAll(async () => {
  stub = await startStubModel({
    script: ['native answer', 'bridged answer', 'added answer', 'after core'],
    route: (request) => {
      if (!request.path.endsWith('/models')) seen.push(request);
      return undefined;
    },
  });
  appData = tempDir('ugw-panel-');
  writeState([
    contour('c1'),
    // Карточка снимает родную ручку пресета: мост в openai-chat, маска выбрана на карточке.
    contour('c2', { manifest: { anthropicMessages: '' }, dataMask: true }),
    contour('off', { enabled: false }),
  ]);
  for (const id of ['c1', 'c2', 'c3', 'off']) setStoredKey(appData, `platform:${id}`, CONTOUR_KEY);
  // Прежний шлюз в панели: держит порт, отвечает сам.
  foreign = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ from: 'panel-gateway' }));
  });
  await new Promise<void>((done) => foreign.listen({ host: '127.0.0.1', port: 0 }, () => done()));
  port = (foreign.address() as AddressInfo).port;
  const home = join(tempDir('ugw-core-'), 'core');
  // Хост звеньев этого дома — в процессе теста и ДО ядра: первый такт ядра находит его по строке
  // `procs.json`, а не поднимает отдельный процесс.
  host = await startHopHost({ home, panelAppData: appData, retryPauseMs: 10 });
  core = await bootCore({
    home,
    build: 'ugw-test',
    panelAppData: appData,
    loop: false,
    userGateway: { port, intervalMs: 200 },
  });
}, 60_000);

afterAll(async () => {
  await core?.stop().catch(() => undefined);
  await host?.close();
  await stub?.close();
  await new Promise<void>((done) => (foreign.listening ? foreign.close(() => done()) : done()));
});

describe('шлюз человека: ядро настраивает его на хосте звеньев из контуров панели', () => {
  it('порт из окружения: пусто — не задано (решает план), 0 или не порт — шлюза нет; число — порт', () => {
    expect(userGatewayPortOf({})).toBeUndefined();
    expect(userGatewayPortOf({ AGENTDECK_USER_GATEWAY_PORT: '0' })).toBeNull();
    expect(userGatewayPortOf({ AGENTDECK_USER_GATEWAY_PORT: 'x' })).toBeNull();
    expect(userGatewayPortOf({ AGENTDECK_USER_GATEWAY_PORT: '5179' })).toBe(5179);
  });

  it('прежний шлюз держит порт — отвечает он; отпустил — ядро берёт порт, ключ контура подставляет звено', async () => {
    const waiting = await until(async () => (await gatewayState()) === 'waiting', 5_000);
    expect(waiting).toBe(true);
    const before = await call('/c1/v1/messages', anthropicBody('hi'));
    expect(before.text).toContain('panel-gateway');
    await new Promise<void>((done) => foreign.close(() => done()));
    const released = Date.now();
    const took = await until(async () => {
      const hello = await fetch(`http://127.0.0.1:${port}/api/hello`);
      return hello.status === 200 && (await hello.text()).includes('hop');
    }, 5_000);
    expect(took).toBe(true);
    expect(Date.now() - released).toBeLessThan(5_000);
    const after = await call('/c1/v1/messages', anthropicBody('hi'));
    expect(after.status).toBe(200);
    expect(after.text).toContain('native answer');
    const upstream = seen.at(-1);
    expect(upstream?.path).toBe('/v1/messages');
    expect(JSON.stringify(upstream?.headers)).toContain(CONTOUR_KEY);
    expect(JSON.stringify(upstream?.headers)).not.toContain('cli-placeholder');
  });

  it('контур без родной ручки — мост в chat с маской карточки; выключенный — 403', async () => {
    const bridged = await call('/c2/v1/messages', anthropicBody(`mail ${EMAIL}`));
    expect(bridged.status).toBe(200);
    expect(bridged.text).toContain('bridged answer');
    expect(seen.at(-1)?.path).toBe('/v1/chat/completions');
    expect(seen.at(-1)?.raw).not.toContain(EMAIL);
    expect((await call('/off/v1/messages', anthropicBody('hi'))).status).toBe(403);
  });

  it('контур, заведённый в панели после загрузки, подхватывается тактом; шлюз переживает ядро', async () => {
    writeState([contour('c1'), contour('c3')]);
    const added = await until(
      async () => (await call('/c3/v1/messages', anthropicBody('hi'))).status === 200,
      5_000,
    );
    expect(added).toBe(true);
    await core?.stop();
    core = undefined;
    const kept = await call('/c1/v1/messages', anthropicBody('hi'));
    expect(kept.status).toBe(200);
    expect(kept.text).toContain('after core');
  });
});

/** Состояние шлюза человека по статусу хоста (протокол управления, токен дома ядра). */
async function gatewayState(): Promise<string | undefined> {
  const token = readToken(join(host.ctx.stateDir, 'control.token'));
  if (!('value' in token)) return undefined;
  const response = await fetch(`http://127.0.0.1:${host.ports.control}/hops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token.value}` },
    body: JSON.stringify({ op: 'status' }),
  });
  const reply = (await response.json()) as HopControlReply;
  return reply.ok && reply.op === 'status' ? reply.status.userGateway?.state : undefined;
}
