/**
 * Надзор ядра панелью (этап 10, зона core-supervisor) — настоящая дорога: одноразовая панель
 * без своего ядра, надзор включён, ядро поднимает ПАНЕЛЬ (`launchCore`: Windows — скрытый
 * PowerShell, POSIX — отвязанный spawn). Подменено только окружение (временные дома).
 *
 * Что проверяется:
 * 1. Ядра нет — панель поднимает его сама: `/api/core/supervisor` = `up` с pid, прокладка
 *    отвечает ядром (`/api/core/health` 200), человеческая команда через прокладку — 200
 *    (перенос ключа устройства: ядро доверяет пиру, только когда надзор записал звено, P131).
 * 2. Ядро убито — надзор поднимает новое (другой pid), звено панели записано новому ядру
 *    (файл итога записи + команда снова 200).
 * 3. Панель снята ДЕРЕВОМ (как закрытое окно, `killProcessTree`) — ядро живо; новая панель
 *    усыновляет то же ядро, второго не поднимает.
 *
 * Красный прогон: `SUPERVISE=0 node tools/qa/check-core-supervisor.mjs` — надзор выключен
 * (прежнее поведение): ядра нет, прокладка отвечает `core-absent`, проверки краснеют.
 *
 * Как запущена панель — `LAUNCH`: `node` (по умолчанию, сервер напрямую), `pnpm-start` (`pnpm start`
 * из корня, как у человека), `dev-watch` (сторож `pnpm dev`): ядро поднимает надзор сервера при
 * любом запуске, отдельного процесса ядра ни `pnpm start`, ни `pnpm dev` не запускают.
 *
 * Запуск: `node tools/qa/check-core-supervisor.mjs` (стенд свой, `pnpm dev` не нужен).
 * Код выхода: 0 — сходится, 1 — провал, 2 — стенд не поднялся.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHopRecord, supervisorsOf } from '../../apps/server/src/lib/hop-recorder.mjs';
import { killProcessTree } from '../../apps/server/src/lib/kill-tree.mjs';
import { mobileModule } from './mobile-lib.mjs';
import { DEFAULT_CORE_STUBS, runOnStand } from './throwaway-stand.mjs';

const { newId } = await import('../../apps/core/src/lib/ids/uuidv7.ts');
const { keyFromSeed } = await mobileModule('shared/api/signing/signing.ts');

const supervise = process.env.SUPERVISE ?? '1';
// `--launch=<…>` сильнее окружения: кейс блока «Тесты» связывается с файлом и аргументом
// (`automation.testName`), а не с окружением.
const launchArg = process.argv.slice(2).find((a) => a.startsWith('--launch='));
const launch = launchArg ? launchArg.slice('--launch='.length) : (process.env.LAUNCH ?? 'node');
if (!['node', 'pnpm-start', 'dev-watch'].includes(launch)) {
  console.log(`Не проверено: неизвестный запуск ${launch} (node | pnpm-start | dev-watch)`);
  process.exit(2);
}
// Дом ядра — свой временный: ядро надзора не в дереве стенда, снимается здесь же в конце.
const coreHome = mkdtempSync(join(tmpdir(), 'cc-core-supervised-home-'));
writeFileSync(
  join(coreHome, 'config.json'),
  `${JSON.stringify({ routes: { stub: DEFAULT_CORE_STUBS } }, null, 2)}\n`,
);
const corePids = new Set();

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Файл итога записи звеньев надзора — в каталоге данных панели стенда. */
function findHopFile(dir, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'core-hops.json') return path;
    if (statSync(path).isDirectory()) {
      const found = findHopFile(path, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// runOnStand кончается process.exit — уборка ядра надзора только в `exit`.
process.once('exit', () => {
  for (const pid of corePids) if (alive(pid)) killProcessTree(pid);
  try {
    rmSync(coreHome, { recursive: true, force: true });
  } catch {
    // каталог держит снимаемое ядро — временный каталог ОС, не дом человека
  }
});

await runOnStand(
  {
    label: `core-supervisor-${launch}`,
    web: false,
    core: false,
    launch,
    env: { AGENTDECK_CORE_SUPERVISE: supervise, AGENTDECK_CORE_HOME: coreHome },
  },
  async (stand, check) => {
    const status = () => stand.api('/core/supervisor').then((r) => r.body);
    async function until(test, ms = 60_000) {
      const end = Date.now() + ms;
      for (;;) {
        const got = await status().catch(() => null);
        if (test(got)) return got;
        if (Date.now() > end) return got;
        await wait(300);
      }
    }
    const machineId = (await stand.api('/system')).body.machineId;
    /** Человеческая команда через прокладку: перенос ключа устройства с числом страницы. */
    async function command() {
      const page = newId();
      const minted = await stand.api(`/core/nonce?page=${page}`);
      if (minted.status !== 200) return minted;
      const key = keyFromSeed(new Uint8Array(randomBytes(32)));
      return stand.api('/core/devices/adopt', {
        method: 'POST',
        body: {
          cmdId: newId(),
          machineId,
          devices: [{ id: key.deviceId, publicKey: key.publicKey }],
          proof: { nonce: minted.body.nonce, page },
        },
      });
    }

    // 1. Ядра нет — панель поднимает его сама.
    const first = await until((s) => s?.state === 'up');
    check(
      'ядра не было — панель подняла его сама (надзор up, pid)',
      first?.state === 'up' && Number.isInteger(first.pid),
      JSON.stringify(first),
    );
    if (first?.pid) corePids.add(first.pid);
    const health = await stand.api('/core/health');
    check(
      'прокладка отвечает ядром: /api/core/health 200',
      health.status === 200,
      `${health.status} ${health.text.slice(0, 300)}`,
    );
    const cmd1 = await command();
    check(
      'человеческая команда через прокладку — 200 (звено панели записано ядру)',
      cmd1.status === 200 && Array.isArray(cmd1.body?.adopted),
      `${cmd1.status} ${cmd1.text.slice(0, 300)}`,
    );
    if (!first?.pid) return;

    // 2. Ядро убито — надзор поднимает новое и записывает ему звено.
    killProcessTree(first.pid);
    const second = await until((s) => s?.state === 'up' && s.pid !== first.pid, 90_000);
    if (second?.pid) corePids.add(second.pid);
    check(
      'ядро убито — надзор поднял новое (другой pid), падение посчитано',
      second?.state === 'up' && second.pid !== first.pid && second.restarts >= 1,
      JSON.stringify(second),
    );
    const hopFile = findHopFile(stand.root);
    let record = null;
    for (let i = 0; i < 30; i += 1) {
      record = hopFile ? readHopRecord(hopFile) : null;
      const channels = supervisorsOf(coreHome);
      const pid = stand.apiPid();
      const fresh = channels.filter((c) => record?.channels?.[c]?.accepted?.includes(pid));
      if (channels.length > 0 && fresh.length === channels.length) break;
      await wait(300);
    }
    const channels = supervisorsOf(coreHome);
    check(
      'звено панели записано новому ядру (P131, файл итога надзора)',
      channels.length > 0 &&
        channels.every((c) => record?.channels?.[c]?.accepted?.includes(stand.apiPid())),
      `${hopFile} ${JSON.stringify(record)} channels=${JSON.stringify(channels)}`,
    );
    const cmd2 = await command();
    check(
      'команда через прокладку новому ядру — 200',
      cmd2.status === 200,
      `${cmd2.status} ${cmd2.text.slice(0, 300)}`,
    );

    // 3. Панель снята деревом — ядро живо; новая панель усыновляет его.
    const panelPid = stand.serverPid();
    const apiPid = stand.apiPid();
    killProcessTree(panelPid);
    for (let i = 0; i < 20 && (alive(panelPid) || alive(apiPid)); i += 1) await wait(250);
    await wait(1_000);
    check('панель снята деревом', !alive(panelPid) && !alive(apiPid), `${panelPid}/${apiPid}`);
    check('ядро пережило панель (не в её дереве)', alive(second.pid), `pid ${second.pid} is gone`);
    await stand.restartHard();
    const adopted = await until((s) => s?.state === 'up');
    check(
      'новая панель усыновила то же ядро, второго не подняла',
      adopted?.state === 'up' && adopted.pid === second.pid && adopted.restarts === 0,
      JSON.stringify(adopted),
    );
    const cmd3 = await command();
    check(
      'команда через новую панель — 200 (звено новой панели записано)',
      cmd3.status === 200,
      `${cmd3.status} ${cmd3.text.slice(0, 300)}`,
    );
  },
);
