import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOP_USER_GATEWAY_PORT_ENV, userGatewayPortOf } from '@agentdeck/contracts/core/hops';
import { describe, expect, it } from 'vitest';

/**
 * Окружение ядра одноразового стенда (`standCoreEnv`, tools/qa/throwaway-stand.mjs; этап 10, зона C,
 * проход 5). Ядро стенда живёт на отдельном доме (`AGENTDECK_CORE_HOME`) и потому само не находит
 * данных панели и не открывает шлюз контуров — пока стенд не назовёт их явно. Мастер контура включал
 * шлюз на ходу, а стенд давал порт лишь при шлюзе, включённом в засеве, и данных панели не давал
 * вовсе: карточка «Шлюз ядра не поднят», шлюз не знал контура.
 *
 * Порт читается тем же разборщиком, что и в ядре (`userGatewayPortOf` из contracts). Что ядро на
 * отдельном доме этим переменным подчиняется, закреплено в тестах ядра (`user-gateway-wiring.test.ts`,
 * `boot.panel-routes.test.ts`): код ядра сюда не тянется (граница depcruise), а весь путь целиком —
 * `tools/qa/check-core-gateway-stand.mjs`. Модуль стенда грузится по адресу, как в
 * `throwaway-stand-reap.process.test.ts`; `STAND_SRC` — модуль под проверкой (для «красного до»).
 */

const REPO = resolve(import.meta.dirname, '..', '..', '..', '..');
const STAND = process.env.STAND_SRC
  ? pathToFileURL(resolve(process.env.STAND_SRC)).href
  : pathToFileURL(join(REPO, 'tools', 'qa', 'throwaway-stand.mjs')).href;

type StandCoreEnv = (
  core: unknown,
  settings: { platformGateway?: { enabled: boolean; port: number } },
  panelData: string,
) => Record<string, string>;

const load = async (): Promise<StandCoreEnv> =>
  ((await import(STAND)) as { standCoreEnv: StandCoreEnv }).standCoreEnv;

const PANEL = '/stand/cfg/agentdeck';

describe('throwaway stand gives its core what the human core finds by itself', () => {
  it('gateway OFF in the seed (the wizard turns it on later): the core still gets the port and the panel data', async () => {
    const standCoreEnv = await load();
    for (const core of [true, { supervised: true }]) {
      const env = standCoreEnv(core, { platformGateway: { enabled: false, port: 61_234 } }, PANEL);
      expect(userGatewayPortOf(env)).toBe(61_234);
      expect(env.AGENTDECK_PANEL_DATA).toBe(PANEL);
    }
  });

  it('gateway ON in the seed: same port, no other source', async () => {
    const standCoreEnv = await load();
    const env = standCoreEnv(true, { platformGateway: { enabled: true, port: 61_235 } }, PANEL);
    expect(env[HOP_USER_GATEWAY_PORT_ENV]).toBe('61235');
  });

  it('no core on the stand: nothing is added', async () => {
    const standCoreEnv = await load();
    expect(
      standCoreEnv(false, { platformGateway: { enabled: true, port: 61_234 } }, PANEL),
    ).toEqual({});
  });
});
