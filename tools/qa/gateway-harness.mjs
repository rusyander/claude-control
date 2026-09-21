/**
 * Общая оснастка проверок, которым нужен НАСТОЯЩИЙ шлюз в отдельном процессе.
 *
 * Зачем модуль. Проверки провода (`check-tool-shim-hooks.mjs`, `check-permission-broker.mjs`)
 * поднимают шлюз одинаково: временный `AppStore`, контур со стаб-платформой
 * наверху, `handleGatewayRequest` на живом порту, дочерний процесс под
 * `--experimental-strip-types`. Одинаковым было и то, что вокруг: ожидание
 * порта, добивание водителя на Ctrl-C, счётчик провалов. Скопированное второй
 * раз, это расходится молча — и расходится в сторону «зелено»: проверка,
 * поднявшая шлюз не так, как соседняя, проверяет другой путь, не сказав об этом.
 *
 * ЧТО ЗДЕСЬ НЕ ЖИВЁТ: ни одного решения о предмете проверки. Оснастка знает,
 * как поднять шлюз, и не знает, что у него спрашивают: ворота, хуки, правила,
 * разбор ответа остаются в самой проверке, где их видно рядом с её таблицей.
 * Поэтому у `gatewayDriverSource` ровно пять дырок — всё различие двух водителей
 * уместилось в них, и подставляется туда ТЕКСТ, который пишет сама проверка.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Проверка не состоялась — это не провал предмета.
 *
 * Разница принципиальная: `NotChecked` выходит кодом 2, и зелёным такой прогон
 * не считается ни при каком чтении, тогда как «провал» (код 1) — это ответ о
 * самом предмете. Отсутствие CLI или не поднявшийся шлюз ответом о предмете
 * не являются.
 */
export class NotChecked extends Error {}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Счётчик провалов и две строки отчёта — общий вид у всех проверок провода. */
export function reporter() {
  let failures = 0;
  const ok = (name) => console.log(`  ✓ ${name}`);
  const bad = (name, detail = '') => {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`);
  };
  return {
    ok,
    bad,
    check: (name, pass, detail = '') => (pass ? ok(name) : bad(name, detail)),
    /** Обнуление перед повторным прогоном — им живёт самопроверка с повреждениями. */
    reset: () => {
      failures = 0;
    },
    get failures() {
      return failures;
    },
  };
}

/**
 * Порт водителя. Пишется файлом, а не читается из stdout: поток водителя отдан
 * его собственным сообщениям, и вылавливать число из них значило бы завести
 * разборщик чужого вывода там, где хватает файла.
 */
export async function waitForPort(portFile, tries = 60) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, 'utf8').trim());
      if (port > 0) return port;
    }
    await sleep(250);
  }
  throw new NotChecked('шлюз проверки не поднялся.');
}

/**
 * Исходник водителя: настоящий `handleGatewayRequest` на временном хранилище.
 *
 * Все пять дырок — текст, который подставляет сама проверка: `imports` (чем
 * дополнить шапку), `title` (имя контура в панели), `setup` (что собрать до
 * подъёма сервера), `deps` (лишние поля зависимостей шлюза), `routes` (ручки
 * ПЕРЕД шлюзом — ими проверка достаёт то, что живёт в чужом процессе).
 * Задание приезжает к водителю аргументом командной строки как `job`.
 */
export function gatewayDriverSource({
  title,
  imports = '',
  setup = '',
  deps = '',
  routes = '',
} = {}) {
  const gatewayTs = new URL(
    '../../apps/server/src/domains/platform/gateway/pipeline.ts',
    import.meta.url,
  ).href;
  const storeTs = new URL('../../apps/server/src/domains/platform/store.ts', import.meta.url).href;
  const appStoreTs = new URL('../../apps/server/src/lib/app-store.ts', import.meta.url).href;
  const usageTs = new URL(
    '../../apps/server/src/domains/platform/gateway/usage.ts',
    import.meta.url,
  ).href;
  return `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { handleGatewayRequest } from ${JSON.stringify(gatewayTs)};
import { writePlatform, writeToken } from ${JSON.stringify(storeTs)};
import { AppStore } from ${JSON.stringify(appStoreTs)};
import { GatewayJournal } from ${JSON.stringify(usageTs)};
${imports}
const job = JSON.parse(process.argv[2]);
const store = new AppStore(job.appDataDir);
writePlatform(store, {
  id: job.contour,
  title: ${JSON.stringify(title)},
  driver: 'enterprise-platform',
  baseUrl: job.upstream,
  enabled: true,
  mode: 'best-effort',
  budgetUsd: 0,
  budgetSince: '',
  capabilities: [],
  targets: [],
  projectPaths: [],
  agents: [],
  caCertPath: '',
  toolShim: true,
});
writeToken(job.appDataDir, job.contour, job.key);

const journal = new GatewayJournal();
${setup}
const deps = { store, appDataDir: job.appDataDir, journal${deps ? `, ${deps}` : ''} };

const server = createServer((request, response) => {
${routes}
  void handleGatewayRequest(request, response, deps).catch((error) => {
    if (!response.headersSent) response.writeHead(500);
    response.end(String(error));
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  writeFileSync(job.portFile, String(typeof address === 'object' && address ? address.port : 0), 'utf8');
});
`;
}

/**
 * Водитель как процесс: запустить, дождаться порта, добить в любом исходе.
 *
 * Водитель, переживший свой прогон, держит порт и пишет в чужую папку, а Ctrl-C
 * и taskkill `finally` вызывающего не запускают — отсюда три обработчика на
 * выход. `stop()` идемпотентен: его зовут и из `finally`, и из обработчика.
 */
export async function startGatewayDriver({ dir, source, job, env }) {
  const driverPath = join(dir, 'driver.ts');
  const portFile = join(dir, 'port.txt');
  writeFileSync(driverPath, source, 'utf8');

  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      driverPath,
      JSON.stringify({ ...job, portFile }),
    ],
    {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false,
    },
  );

  const reap = () => child.kill();
  process.once('exit', reap);
  const onSignal = (code) => () => {
    reap();
    process.exit(code);
  };
  process.once('SIGINT', onSignal(130));
  process.once('SIGTERM', onSignal(143));

  const port = await waitForPort(portFile);
  return { port, stop: reap };
}
