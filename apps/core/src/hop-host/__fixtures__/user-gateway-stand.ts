import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HopControlReply } from '@agentdeck/contracts/core/hops';
import { defaultOurRules } from '@agentdeck/contracts/platform';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import type { RouteReply, RouteRequest } from '@agentdeck/stub-model';
import { readPanelProfiles } from '../../bootstrap/panel-profiles.ts';
import { userRouteOf } from '../../bootstrap/user-gateway-wiring.ts';
import { contourStoreId } from '../../routes/gateway/gateway.ts';
import { hopStand, type HopStand } from './hop-stand.ts';

/**
 * Стенд шлюза человека с настоящим путём от файла панели до провода: `state.json` панели →
 * `readPanelProfiles` → `userRouteOf` (ядро) → настройка хоста звеньев → запрос CLI → контур
 * (заглушка `packages/stub-model`). Подменена только модель на границе сети.
 */

export const CONTOUR_KEY = 'platform-token-5e1a';
export const CONTOUR_RULES = {
  platformTools: ['web_search'],
  toolMode: 'loop' as const,
  generationPreset: 'precise',
  enableThinking: 'on' as const,
};

export interface UserGatewayStand {
  stand: HopStand;
  panel: string;
  port: number;
  control(message: unknown): Promise<HopControlReply>;
  /** Записать контур в `state.json` панели (поверх записи по умолчанию). */
  writeContour(over: Record<string, unknown>, settings?: Record<string, unknown>): void;
  /** Такт ядра: профили панели заново → маршруты → хост звеньев. */
  apply(): Promise<void>;
  /** Записи следа шлюза (`<home>/hops/trace.jsonl`, звено `gateway`). */
  trace(): Record<string, unknown>[];
  /** Тело последнего запроса, дошедшего до контура. */
  sentBody(): Record<string, unknown>;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

export async function userGatewayStand(
  over: Record<string, unknown> = {},
  options: {
    reply?: (request: RouteRequest) => RouteReply | undefined;
    prepare?: (appData: string) => void;
    /** Постоянный адрес своей модели — порт заглушки (фронт C4 пересылает запрос как есть). */
    localFront?: boolean;
  } = {},
): Promise<UserGatewayStand> {
  const stand = await hopStand({
    script: Array.from({ length: 12 }, (_, i) => `answer ${i + 1}`),
    prepare: (appData) => {
      setStoredKey(appData, contourStoreId('corp'), CONTOUR_KEY);
      options.prepare?.(appData);
    },
    ...(options.reply ? { reply: options.reply } : {}),
  });
  const panel = mkdtempSync(join(tmpdir(), 'hop-panel-'));
  const port = await freePort();
  const control = async (message: unknown): Promise<HopControlReply> => {
    const response = await fetch(`${stand.handle.url}/hops`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${stand.handle.token}`,
      },
      body: JSON.stringify(message),
    });
    return (await response.json()) as HopControlReply;
  };
  const writeContour = (
    patch: Record<string, unknown>,
    settings: Record<string, unknown> = {},
  ): void => {
    const platform = {
      id: 'corp',
      title: 'Company · dev',
      driver: 'enterprise-platform',
      baseUrl: stand.stub.baseUrl,
      enabled: true,
      mode: 'required',
      consumers: ['chat'],
      rules: { platform: CONTOUR_RULES, ours: defaultOurRules() },
      ...patch,
    };
    writeFileSync(
      join(panel, 'state.json'),
      JSON.stringify({ settings: { ...settings, platforms: [platform] } }),
    );
  };
  const apply = async (): Promise<void> => {
    const profiles = readPanelProfiles(panel);
    if (profiles.problems.length > 0) throw new Error(profiles.problems.join('; '));
    const front = options.localFront ? Number(new URL(stand.stub.baseUrl).port) : undefined;
    const routes = profiles.contours.map((contour) => userRouteOf(profiles, contour, front));
    const reply = await control({ op: 'user-gateway', port, routes });
    if (!reply.ok) throw new Error(`user-gateway refused: ${reply.detail}`);
  };
  writeContour(over);
  await apply();
  const deadline = Date.now() + 3_000;
  for (;;) {
    const status = await control({ op: 'status' });
    if (status.ok && status.op === 'status' && status.status.userGateway?.state === 'listening')
      break;
    if (Date.now() > deadline) throw new Error('user gateway did not listen');
    await new Promise((done) => setTimeout(done, 30));
  }
  return {
    stand,
    panel,
    port,
    control,
    writeContour,
    apply,
    trace: () => {
      const file = join(stand.home, 'hops', 'trace.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.hop === 'gateway');
    },
    sentBody: () => JSON.parse(stand.seen.at(-1)?.raw ?? '{}') as Record<string, unknown>,
    close: async () => {
      await stand.close().catch(() => undefined);
      rmSync(panel, { recursive: true, force: true });
    },
  };
}
