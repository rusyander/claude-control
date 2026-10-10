/**
 * Сервер OpenCode не переживает жёстко убитую панель.
 *
 * Живая приёмка 10.10: два `opencode serve` жили сутки после своих панелей
 * (одноразовые стенды проверок 09.10) и держали порты. Панель гасила сервер
 * только в обработчике выхода, а `node --watch` на Windows, падение или снятие
 * стенда убивают её без обработчиков. Теперь номер сервера пишется в журнал
 * каталога данных, и следующий старт панели снимает сироту.
 *
 * Своя одноразовая панель (без фронта и без Claude), настоящий `opencode`,
 * заглушка модели (`stub-steer-model.mjs`):
 *  1. разговор с провайдером OpenCode → поднят `opencode serve`, номер в журнале;
 *  2. панель снята ОДНИМ процессом без обработчиков (`restartHard`) и поднята
 *     заново на том же доме → прежний `opencode serve` снят, журнал пуст;
 *  3. новый разговор после перезапуска отвечает (поднят новый сервер).
 *
 * Подменена только модель. CLI — из `STEER_CLI_DIR` или PATH; нет — код 2.
 * Красное до правки: прежний сервер жив после шага 2.
 * Запуск: `node tools/qa/check-opencode-serve-orphan.mjs`.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { reporter, startStand, wait } from './throwaway-stand.mjs';
import { startStubModel } from './stub-steer-model.mjs';

const IS_WIN = process.platform === 'win32';
const LEDGER = 'opencode-serve-runs.json';

function findCli() {
  const names = IS_WIN ? ['opencode.cmd', 'opencode.exe', 'opencode'] : ['opencode'];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Номера живых `opencode … serve` (сам бинарник, не обёртка). */
function servePids() {
  const rows = IS_WIN
    ? execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process -Filter "Name=\'opencode.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
        ],
        { encoding: 'utf8' },
      )
    : execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return new Set(
    rows
      .split(/\r?\n/)
      .map((row) => row.trim().match(/^(\d+)\s+(.*)$/))
      .filter((m) => m && /opencode/i.test(m[2]) && /\bserve\b/.test(m[2]))
      .map((m) => Number(m[1])),
  );
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

async function until(probe, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const value = await probe();
    if (value) return value;
    await wait(250);
  }
  return undefined;
}

/** Файл журнала где-то в доме стенда (каталог данных зависит от раскладки без Claude). */
function findLedger(dir, depth = 5) {
  if (depth < 0 || !existsSync(dir)) return undefined;
  const direct = join(dir, LEDGER);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const hit = findLedger(join(dir, entry.name), depth - 1);
    if (hit) return hit;
  }
  return undefined;
}

const { check, finish } = reporter();
const cliDir = findCli();
if (!cliDir) {
  console.log('Не проверено: opencode нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}

const stub = await startStubModel({ marker: 'never-steered', holdMs: 200, toolLine: 'echo ok' });
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-opencode-orphan-')));
const configFile = join(root, 'opencode.json');
writeFileSync(
  configFile,
  JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      stub: {
        npm: '@ai-sdk/openai-compatible',
        name: 'stub',
        options: { baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'x' },
        models: { 'stub-model': { name: 'stub', tool_call: true } },
      },
    },
    model: 'stub/stub-model',
  }),
);
const xdg = (name) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const cliEnv = {
  OPENCODE_CONFIG: configFile,
  XDG_CONFIG_HOME: xdg('xdg-config'),
  XDG_DATA_HOME: xdg('xdg-data'),
  XDG_STATE_HOME: xdg('xdg-state'),
  XDG_CACHE_HOME: xdg('xdg-cache'),
};

async function converse(stand, dir) {
  mkdirSync(dir, { recursive: true });
  const created = await stand.api('/provider-chat/chats', {
    method: 'POST',
    body: { workdir: dir },
  });
  if (created.status !== 200) throw new Error(`разговор не создан: ${created.text}`);
  const id = created.body.id;
  await stand.api(`/provider-chat/chats/${id}`, { method: 'PATCH', body: { allowEdits: true } });
  const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
    method: 'POST',
    body: { text: 'Скажи что-нибудь.' },
  });
  if (sent.status !== 200) throw new Error(`вопрос не принят: ${sent.text}`);
  // Статус «не идёт» бывает и ДО начала хода — ждём ответ ассистента и конец хода.
  const ended = await until(async () => {
    const status = (await stand.api(`/provider-chat/chats/${id}/status`)).body;
    const chat = (await stand.api(`/provider-chat/chats/${id}`)).body;
    return status?.isRunning === false && chat?.messages?.at(-1)?.role === 'assistant';
  }, 120);
  const chat = (await stand.api(`/provider-chat/chats/${id}`)).body;
  return { ended: Boolean(ended), last: chat?.messages?.at(-1) };
}

const before = servePids();
const ours = new Set();
let stand;
try {
  stand = await startStand({
    web: false,
    noClaude: true,
    label: 'opencode-orphan',
    settings: { provider: 'opencode' },
    extraPath: [cliDir],
    env: cliEnv,
  });

  const first = await converse(stand, join(root, 'projects', 'a'));
  check(
    '1: разговор через opencode serve кончился ответом',
    first.ended && first.last?.role === 'assistant' && first.last?.transport === 'session',
    JSON.stringify(first.last)?.slice(0, 300),
  );
  const started = [...servePids()].filter((pid) => !before.has(pid));
  started.forEach((pid) => ours.add(pid));
  check(
    '1: поднят ровно один opencode serve',
    started.length === 1,
    `новые: ${started.join(', ')}`,
  );
  const ledgerFile = findLedger(stand.home);
  const ledgerText = ledgerFile ? readFileSync(ledgerFile, 'utf8') : '';
  check(
    '1: номер сервера записан в журнал каталога данных',
    started.length === 1 && new RegExp(`"pid":\\s*${started[0]}\\b`).test(ledgerText),
    ledgerFile ? `${ledgerFile}: ${ledgerText.slice(0, 300)}` : 'журнала нет',
  );

  const { killedPid } = await stand.restartHard();
  check('2: прежний процесс панели снят', !alive(killedPid), `pid ${killedPid}`);
  const gone = await until(() => started.every((pid) => !alive(pid)), 10);
  check(
    '2: после старта новой панели прежний opencode serve снят',
    Boolean(gone),
    started.map((pid) => `${pid}:${alive(pid) ? 'жив' : 'снят'}`).join(', '),
  );
  const ledgerAfter = ledgerFile && existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : '';
  check(
    '2: журнал не держит снятый номер',
    !started.some((pid) => ledgerAfter.includes(String(pid))),
    ledgerAfter.slice(0, 300) || 'пусто',
  );

  const second = await converse(stand, join(root, 'projects', 'b'));
  [...servePids()].filter((pid) => !before.has(pid)).forEach((pid) => ours.add(pid));
  check(
    '3: после перезапуска разговор снова отвечает через новый сервер',
    second.ended && second.last?.role === 'assistant' && second.last?.transport === 'session',
    JSON.stringify(second.last)?.slice(0, 300),
  );
} finally {
  if (stand) await stand.stop();
  // Сирота от прогона «до правки» не должна пережить проверку.
  for (const pid of ours) {
    try {
      process.kill(pid);
    } catch {
      // уже снят
    }
  }
  await stub.close?.();
}
finish();
