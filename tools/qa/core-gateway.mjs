/**
 * Шлюз контуров ядра для проверок провода — тот же путь, что у CLI человека.
 *
 * Шлюз панели снят (этап 10, C3d): адрес `127.0.0.1:<порт>/<контур>/v1` держит шлюз человека на
 * хосте звеньев ядра. Проверке нужен он сам, а не копия: хост звеньев на временном доме, маршруты —
 * `userRouteOf` из `state.json` панели (как у ядра на старте), ключ — из хранилища того же каталога
 * данных. Учёт и след — книга контуров звена (`op: 'contours'`).
 *
 * Форма повторяет прежний `PlatformGateway` (`start`/`status`/`stop`), чтобы проверки менялись
 * только в строке запуска; след (`events()`) — асинхронный: он читается у звена по сети, старые
 * сверху, как писал прежний шлюз.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((done) => server.close(() => done()));
  return port;
}

export function coreGateway() {
  let host;
  let home;
  let token = '';
  let appData = '';
  let port = 0;
  let running = false;

  const control = async (message) => {
    const response = await fetch(`http://127.0.0.1:${host.ports.control}/hops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(message),
    });
    return response.json();
  };

  /** Маршруты из `state.json` панели — заново: проверка могла поменять контур после старта. */
  const apply = async () => {
    const { readPanelProfiles } = await import('../../apps/core/src/bootstrap/panel-profiles.ts');
    const { userRouteOf } = await import('../../apps/core/src/bootstrap/user-gateway-wiring.ts');
    const profiles = readPanelProfiles(appData);
    if (profiles.problems.length > 0) throw new Error(profiles.problems.join('; '));
    const routes = profiles.contours.map((contour) => userRouteOf(profiles, contour));
    const reply = await control({ op: 'user-gateway', port, routes });
    if (!reply.ok) throw new Error(`шлюз ядра отказал: ${reply.detail}`);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const status = await control({ op: 'status' });
      if (status.ok && status.status.userGateway?.state === 'listening') return;
      if (Date.now() > deadline) throw new Error('шлюз ядра не начал слушать порт');
      await new Promise((done) => setTimeout(done, 30));
    }
  };

  return {
    async start({ appDataDir, port: wanted = 0 }) {
      const { startHopHost } = await import('../../apps/core/src/hop-host/host.ts');
      const { readToken } = await import('../../apps/core/src/platform/token-file.ts');
      appData = appDataDir;
      home = mkdtempSync(join(tmpdir(), 'qa-core-gw-'));
      host = await startHopHost({ home, panelAppData: appDataDir });
      const read = readToken(join(home, 'hops', 'control.token'));
      if (!('value' in read)) throw new Error('токен управления хоста звеньев не читается');
      token = read.value;
      port = wanted || (await freePort());
      await apply();
      running = true;
    },
    /** Контур поменялся в `state.json` — пересобрать маршруты, как ядро по наблюдателю. */
    refresh: apply,
    status() {
      return { running, port };
    },
    /** Дом хоста звеньев — его же берёт ядро, поднятое рядом (`bootCore`), чтобы звать то же звено. */
    home: () => home,
    async events() {
      if (!host) return [];
      const reply = await control({ op: 'contours' });
      return reply.ok ? [...reply.contours.events].reverse() : [];
    },
    async stop() {
      if (!host) return;
      running = false;
      await control({ op: 'user-gateway', port: null, routes: [] }).catch(() => undefined);
      await host.close();
      host = undefined;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
