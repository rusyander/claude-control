import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store.ts';
import { PlatformGateway } from './listener.ts';

/**
 * Слушатель шлюза: занятый порт — не падение.
 *
 * Проверяется ровно то, из-за чего это правило заведено: у панели уже есть свой
 * слушатель на 5179 (прокси защиты данных), и упавший при старте шлюз выглядел
 * бы как «шлюз не работает вообще», хотя достаточно взять соседний порт и
 * назвать его.
 */

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let squatter: Server | undefined;

/** Кто-то уже сидит на порту — обычное дело на машине с поднятой панелью. */
async function occupy(): Promise<number> {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  squatter = server;
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-gateway-listen-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  gateway = new PlatformGateway();
});

afterEach(async () => {
  await gateway.stop();
  if (squatter) await new Promise<void>((resolve) => squatter?.close(() => resolve()));
  squatter = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('порт', () => {
  it('занятый порт уступается соседнему, и разница видна', async () => {
    const busy = await occupy();
    await gateway.start({ store, appDataDir: appData, port: busy });

    const status = gateway.status();
    expect(status.running).toBe(true);
    expect(status.port).toBe(busy + 1);
    // Человек копирует адрес отсюда, поэтому разница между «просили» и
    // «досталось» обязана быть на виду, а не в логах.
    expect(status.requestedPort).toBe(busy);
    expect(status.address).toBe(`http://127.0.0.1:${busy + 1}`);
  });

  it('остановленный шлюз не держит порт и не показывает адрес', async () => {
    await gateway.start({ store, appDataDir: appData, port: 0 });
    const port = gateway.status().port;
    await gateway.stop();

    expect(gateway.status().running).toBe(false);
    expect(gateway.status().address).toBe('');
    expect(gateway.status().routes).toEqual([]);

    // Порт свободен: следующий слушатель на нём поднимается без спора.
    const again = new PlatformGateway();
    await again.start({ store, appDataDir: appData, port });
    expect(again.status().port).toBe(port);
    await again.stop();
  });

  it('повторный старт не плодит слушателей', async () => {
    await gateway.start({ store, appDataDir: appData, port: 0 });
    const first = gateway.status().port;
    await gateway.start({ store, appDataDir: appData, port: first });
    expect(gateway.status().port).toBe(first);
  });

  it('доставшийся порт публикуется в состоянии — сторожу больше негде его взять', async () => {
    const busy = await occupy();
    await gateway.start({ store, appDataDir: appData, port: busy });
    // Задуманный порт совпадает с портом прокси защиты данных: сторож, следящий
    // за ним, слушал бы ЧУЖОЙ слушатель и смерти шлюза не заметил.
    expect(new AppStore(appData).getState().platformGatewayPort).toBe(busy + 1);

    await gateway.stop();
    expect(new AppStore(appData).getState().platformGatewayPort).toBe(0);
  });

  it('управляемый профиль переезжает на доставшийся порт вместе со шлюзом', async () => {
    const busy = await occupy();
    store.updateSettings({
      platforms: [
        {
          id: 'enterprise-platform-dev',
          title: 'Платформа компании',
          driver: 'enterprise-platform',
          baseUrl: 'https://api.dev.example.ru',
          enabled: true,
          mode: 'required',
          capabilities: [],
          budgetUsd: 0,
          targets: [],
          projectPaths: [],
          consumers: [],
          agents: [],
          budgetSince: '',
          toolShim: true,
          contourPrompt: true,
          caCertPath: '',
        },
      ],
      platformGateway: { enabled: true, port: busy, forceStream: true },
      endpointProfiles: [
        {
          id: 'contour-enterprise-platform-dev',
          name: 'Контур · Платформа компании',
          baseUrl: `http://127.0.0.1:${busy}/enterprise-platform-dev/v1`,
          apiKind: 'openai-compat',
          model: 'gpt-4o',
          writeToken: false,
          ownerPlatformId: 'enterprise-platform-dev',
        },
      ],
    });

    await gateway.start({ store, appDataDir: appData, port: busy });

    // Профиль — ХРАНИМАЯ запись с адресом внутри, и ассистент панели читает её
    // как есть: оставшийся в ней задуманный порт означал бы промпты, ушедшие
    // тому процессу, который порт и занял.
    expect(
      store.getSettings().endpointProfiles.find((item) => item.id === 'contour-enterprise-platform-dev')
        ?.baseUrl,
    ).toBe(`http://127.0.0.1:${busy + 1}/enterprise-platform-dev/v1`);
  });
});

describe('остановка', () => {
  it('не ждёт живого соединения дольше отсрочки', async () => {
    await gateway.start({ store, appDataDir: appData, port: 0 });
    const port = gateway.status().port;

    // Клиент, который держит соединение и ничего не просит, — это keep-alive
    // сокет любого CLI. `server.close()` сам по себе ждал бы его до конца.
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });

    const started = Date.now();
    await gateway.stop();
    socket.destroy();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(gateway.status().running).toBe(false);
  });
});

describe('состояние до первого запроса', () => {
  it('без контуров адресов нет, счётчики пусты, подписи названы', async () => {
    await gateway.start({ store, appDataDir: appData, port: 0 });
    const status = gateway.status();
    expect(status.routes).toEqual([]);
    expect(status.usage).toEqual([]);
    expect(status.events).toEqual([]);
    expect(status.requests).toBe(0);
    expect(status.compromises).toEqual([
      'dialect-bridge',
      'vendor-sse-frames',
      'status-451-bridge',
      'gateway-required',
      'nonstream-120s',
      'context-managed',
      // Прослойка инструментов (Т5): схемы едут текстом на КАЖДОМ ходе, кэша
      // промпта у платформы нет.
      'shim-no-cache',
    ]);
  });

  it('невключённый шлюз ничего о себе не выдумывает', () => {
    const status = gateway.status();
    expect(status.running).toBe(false);
    expect(status.port).toBe(0);
    expect(status.error).toBeUndefined();
  });
});
