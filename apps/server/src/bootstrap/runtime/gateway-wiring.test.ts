import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformGatewayEvent } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import {
  createCoreContours,
  type CoreContoursOptions,
} from '../../domains/platform/contours/index.ts';
import { wireGateway, type GatewayWiring } from './gateway-wiring.ts';

/**
 * Проводка шлюза отдаёт сторожу контура отказы, пахнущие правами (этап 10, C3d п.5): путь запроса
 * CLI теперь у ядра, и единственный путь отказа 401/403 к `PlatformWatch.noteRightsRefusal` —
 * `onEvents: createRightsFeed(...)` в сборке учёта контуров. Выпади эта строка — сторож молчал бы,
 * а каждая отдельная часть (лента, учёт, сторож) оставалась бы зелёной в своих тестах. Здесь
 * учёт собирается настоящим `createCoreContours` (опрос в тестах не заводится), подменён только
 * сборщик, чтобы увидеть слушателей, с которыми проводка его собрала.
 */

const wired: GatewayWiring[] = [];
afterEach(() => {
  for (const w of wired.splice(0)) w.platformWatch.stop();
});

function context(): ServerContext {
  const appData = mkdtempSync(join(tmpdir(), 'cc-gateway-wiring-'));
  return {
    store: { getSettings: () => ({ platformProbeMinutes: 0, dlp: { port: 0 } }) },
    location: { paths: { appData } },
  } as unknown as ServerContext;
}

/** Лента прав читает у события только время, статус и контур — остальные поля ей безразличны. */
const event = (status: number, platformId: string): PlatformGatewayEvent =>
  ({
    at: new Date(Date.now() + 60_000).toISOString(),
    platformId,
    path: '/v1/messages',
    dialect: 'anthropic',
    status,
    stages: [],
    summarized: false,
  }) as Partial<PlatformGatewayEvent> as PlatformGatewayEvent;

describe('wireGateway: the contour ledger feeds rights refusals to the watch', () => {
  it('a new 401/403 contour event from the core ledger reaches PlatformWatch.noteRightsRefusal, a 200 does not', () => {
    let options: CoreContoursOptions | undefined;
    const notify = { telegram: () => undefined, webhook: () => undefined };
    const w = wireGateway(
      context(),
      notify,
      { VITEST: 'true' },
      {
        createContours: (given) => {
          options = given;
          return createCoreContours(given);
        },
      },
    );
    wired.push(w);
    const noted = vi.spyOn(w.platformWatch, 'noteRightsRefusal').mockImplementation(() => {});

    expect(options?.onEvents).toBeTypeOf('function');
    options?.onEvents?.([event(200, 'ok'), event(403, 'acme'), event(401, 'beta')]);
    expect(noted.mock.calls.map(([id]) => id).sort()).toEqual(['acme', 'beta']);
  });
});
