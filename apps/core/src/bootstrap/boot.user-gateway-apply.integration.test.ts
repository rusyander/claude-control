import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreContoursApplyReply } from '@agentdeck/contracts/core/hops';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { anthropicBody } from '../hop-host/__fixtures__/hop-stand.ts';
import { startHopHost, type RunningHopHost } from '../hop-host/host.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Правка контура доходит до шлюза человека СРАЗУ (s10 G7): панель записала карточку и зовёт
 * `POST /v1/contours/apply` — ответ приходит, когда хост звеньев уже принял маршруты, и следующий
 * запрос CLI видит правку. Такт ядра здесь нарочно длинный (10 мин): без зова раздел, снятый на
 * карточке, отвечал бы 200 до такта — так и было (1,8–4,7 с при такте 5 с, замер G2).
 * Настоящие загрузка ядра, хост звеньев и `@agentdeck/stub-model` верхом; каталог панели временный.
 */

const j = (...parts: string[]): string => parts.join('');
const CONTOUR_KEY = j('sk-', 'contour', '-apply-0123456789');

let stub: StubModel;
let core: BootedCore | undefined;
let host: RunningHopHost;
let appData: string;
let port: number;

function writeState(consumers: string[]): void {
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({
      settings: {
        dlp: { enabled: false },
        platforms: [
          {
            id: 'c1',
            title: 'Контур c1',
            driver: 'litellm',
            baseUrl: stub.baseUrl,
            enabled: true,
            consumers,
          },
        ],
      },
    }),
  );
}

async function viaSection(section: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/c1/_s/${section}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'cli-placeholder' },
    body: JSON.stringify(anthropicBody('hi')),
  });
  await response.text();
  return response.status;
}

async function apply(): Promise<{ status: number; body: CoreContoursApplyReply }> {
  if (!core) throw new Error('core is down');
  const token = readFileSync(core.layout.token, 'utf8').trim();
  const response = await fetch(`${core.url}/v1/contours/apply`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: response.status, body: (await response.json()) as CoreContoursApplyReply };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen({ host: '127.0.0.1', port: 0 }, () => done()));
  const free = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return free;
}

beforeAll(async () => {
  stub = await startStubModel({ script: ['one', 'two', 'three', 'four'] });
  appData = tempDir('ugw-apply-panel-');
  writeState(['chat', 'assistant']);
  setStoredKey(appData, 'platform:c1', CONTOUR_KEY);
  port = await freePort();
  const home = join(tempDir('ugw-apply-core-'), 'core');
  host = await startHopHost({ home, panelAppData: appData, retryPauseMs: 10 });
  core = await bootCore({
    home,
    build: 'ugw-apply-test',
    panelAppData: appData,
    loop: false,
    userGateway: { port, intervalMs: 600_000 },
  });
}, 60_000);

afterAll(async () => {
  await core?.stop().catch(() => undefined);
  await host?.close();
  await stub?.close();
});

describe('шлюз человека: правка контура применяется зовом панели, не тактом', () => {
  it('снятый раздел отвечает 403 сразу после ответа apply; возвращённый — 200 сразу', async () => {
    // Первый такт загрузки идёт без ожидания — apply дожидается его и настраивает заново.
    const first = await apply();
    expect(first.status).toBe(200);
    expect(first.body.applied).toBe(true);
    expect(first.body.userGateway?.state).toBe('listening');
    expect(await viaSection('assistant')).toBe(200);

    writeState(['chat']);
    const closed = await apply();
    expect(closed.status).toBe(200);
    expect(await viaSection('assistant')).toBe(403);
    expect(await viaSection('chat')).toBe(200);

    writeState(['chat', 'assistant']);
    expect((await apply()).status).toBe(200);
    expect(await viaSection('assistant')).toBe(200);
  });
});
