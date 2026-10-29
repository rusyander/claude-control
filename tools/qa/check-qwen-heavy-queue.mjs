/**
 * Очередь тяжёлых шагов у группы Qwen Code (3.2 плана экономии) — живым `qwen` (0.25+).
 *
 * Слой системных настроек собирает тот же код, что и прогон панели (`writeQwenQuietRun` с
 * очередью), хук — настоящий `tools/heavy-queue-hook.mjs`. Модель — заглушка (OpenAI chat,
 * поток): на первом ходе просит оболочку выполнить `pnpm test` во временном пакете, где
 * скрипт `test` пишет время своего запуска в файл.
 *
 * Место в очереди держит чужая аренда (другая группа гоняет гейт) и отпускает его через
 * несколько секунд. Свидетели: время запуска команды (обязано быть ПОСЛЕ освобождения), пустой
 * каталог аренд после хода (конец команды отдал место). Контроль — тот же прогон слоем
 * обычного разговора (очереди нет): команда обязана пойти сразу, иначе проверка ничего не
 * доказывает.
 *
 * CLI ищется в `QWEN_CLI` (путь к `cli-entry.js` или к исполняемому `qwen`), иначе в каталогах
 * `STEER_CLI_DIR` и PATH. Нет CLI — «НЕ ПРОВЕРЕНО», код 2 (junit-run считает это пропуском).
 * Настоящие `~/.qwen`, домашний каталог и очередь панели не трогаются — всё во временной папке.
 *
 * Запуск: node tools/qa/check-qwen-heavy-queue.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startStubModel } from '../../packages/stub-model/src/index.mjs';

// Слой собираем из `.ts`: Node 22 без флага TypeScript не читает, а junit-run зовёт скрипт
// голым `node` — перезапускаемся с флагом и отдаём его код выхода.
if (!process.features.typescript) {
  const self = spawnSync(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(self.status ?? 1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(ROOT, 'tools', 'heavy-queue-hook.mjs');
/**
 * Сколько чужая аренда держит место после старта CLI: втрое дольше запуска qwen 0.25 до
 * первой команды (3,6 с, 17.10), чтобы контроль успевал пойти ДО освобождения.
 */
const HOLD_MS = 10_000;

/** Как запустить qwen: `[команда, ...аргументы]` или null. */
function findQwen() {
  const pick = (p) => (p.endsWith('.js') ? [process.execPath, p] : [p]);
  if (process.env.QWEN_CLI)
    return existsSync(process.env.QWEN_CLI) ? pick(process.env.QWEN_CLI) : null;
  const dirs = [process.env.STEER_CLI_DIR, process.env.PATH].filter(Boolean).join(delimiter);
  for (const dir of dirs.split(delimiter)) {
    // Пакет лежит рядом с `.bin` (`node_modules/.bin/qwen`) или под префиксом npm (Windows:
    // `<prefix>/qwen` + `<prefix>/node_modules/@qwen-code`).
    const entry = [join(dir, '..'), join(dir, 'node_modules')]
      .map((base) => join(base, '@qwen-code', 'qwen-code', 'cli-entry.js'))
      .find((p) => existsSync(p));
    if (existsSync(join(dir, 'qwen')) && entry) return pick(entry);
    if (process.platform !== 'win32' && existsSync(join(dir, 'qwen')))
      return pick(join(dir, 'qwen'));
  }
  return null;
}

/** Заглушка модели: без результата инструмента — вызов оболочки с `command`, иначе «DONE». */
async function startModel(command) {
  const stub = await startStubModel({
    script: ({ info }) => {
      const shell = info.tools.map((tool) => tool.name).find((name) => /shell|bash/i.test(name));
      const usage = { input: 5, output: 1 };
      if (!shell || info.hasToolResult) return { text: 'DONE', usage };
      const args = { command, is_background: false, description: 'gate' };
      return { tool: { name: shell, args, id: 'call1' }, usage };
    },
  });
  return { base: stub.baseUrl, bodies: stub.bodies, close: () => stub.close() };
}

const { writeQwenQuietRun } = await import(
  pathToFileURL(join(ROOT, 'apps/server/src/domains/provider-chat/system-note/system-note.ts')).href
);

/** Один прогон: `group` — слой группы (с очередью), иначе обычного разговора. */
async function runOnce(qwen, root, name, { group }) {
  const dir = join(root, name);
  const pkg = join(dir, 'pkg');
  const home = join(dir, 'qwen-home');
  const user = join(dir, 'user');
  const queue = join(dir, 'queue');
  for (const d of [pkg, home, user, join(queue, 'leases')]) mkdirSync(d, { recursive: true });
  const stampFile = join(pkg, 'ran.txt');
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'gate',
      private: true,
      scripts: { test: `node -e "require('fs').writeFileSync('ran.txt', String(Date.now()))"` },
    }),
  );
  const layer = writeQwenQuietRun({
    appData: join(dir, 'app-data'),
    group,
    // Основа — пустой файл: системные настройки машины проверку не трогают.
    env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: join(dir, 'no-machine-settings.json') },
    heavyQueue: { hook: `node "${HOOK}"`, dir: queue },
  });
  // Чужая группа держит место: её аренда отпускается через HOLD_MS после старта CLI.
  const foreign = join(queue, 'leases', 'toolu_foreign.json');
  writeFileSync(
    foreign,
    JSON.stringify({
      session: 'other-group',
      toolUseId: 'toolu_foreign',
      until: Date.now() + 120_000,
      command: 'pnpm test',
    }),
  );
  const model = await startModel('pnpm test');
  const env = {
    ...process.env,
    ...layer,
    QWEN_HOME: home,
    HOME: user,
    USERPROFILE: user,
    OPENAI_BASE_URL: `${model.base}/v1`,
    OPENAI_API_KEY: 'x',
    OPENAI_MODEL: 'stub-model',
    QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
    AGENTDECK_HEAVY_POLL_MS: '200',
  };
  // Каталог очереди — только из слоя: тот, что мог достаться этому процессу от панели, — вон.
  if (!group) delete env.AGENTDECK_HEAVY_QUEUE_DIR;
  const started = Date.now();
  let releasedAt = 0;
  const release = setTimeout(() => {
    releasedAt = Date.now();
    rmSync(foreign, { force: true });
  }, HOLD_MS);
  const child = spawn(
    qwen[0],
    [...qwen.slice(1), '-p', 'run the gate', '--yolo', '--output-format', 'json'],
    { cwd: pkg, env },
  );
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.resume();
  const exit = await new Promise((r) => {
    const t = setTimeout(() => (child.kill(), r('timeout')), 180_000);
    child.on('exit', (c) => (clearTimeout(t), r(c)));
  });
  clearTimeout(release);
  if (!releasedAt) releasedAt = Date.now();
  model.close();
  const ranAt = existsSync(stampFile) ? Number(readFileSync(stampFile, 'utf8')) : 0;
  const leasesLeft = readdirSync(join(queue, 'leases')).filter((n) => n !== 'toolu_foreign.json');
  return {
    exit,
    stderr: stderr.slice(-400),
    requests: model.bodies.length,
    ranAt,
    releasedAt,
    waitedMs: ranAt ? ranAt - started : -1,
    afterRelease: ranAt >= releasedAt,
    leasesLeft,
    queueEnv: layer.AGENTDECK_HEAVY_QUEUE_DIR ?? null,
  };
}

const qwen = findQwen();
if (!qwen) {
  console.log('НЕ ПРОВЕРЕНО: qwen не найден (QWEN_CLI или PATH)');
  process.exit(2);
}
const version = spawnSync(qwen[0], [...qwen.slice(1), '--version'], {
  encoding: 'utf8',
}).stdout.trim();
const root = mkdtempSync(join(tmpdir(), 'check-qwen-heavy-queue-'));
const rows = [];
const row = (what, expected, actual, ok) => rows.push({ what, expected, actual, ok });
try {
  const queued = await runOnce(qwen, root, 'group', { group: true });
  const control = await runOnce(qwen, root, 'chat', { group: false });

  row(
    'группа: CLI завершился',
    'код 0, два запроса к модели',
    `${queued.exit}, ${queued.requests}`,
    queued.exit === 0 && queued.requests === 2,
  );
  row(
    'группа: каталог очереди в окружении слоя',
    'есть',
    String(queued.queueEnv),
    Boolean(queued.queueEnv),
  );
  row(
    'группа: гейт ждал чужую аренду',
    `запуск после освобождения (держали ${HOLD_MS} мс)`,
    `запуск через ${queued.waitedMs} мс, после освобождения: ${queued.afterRelease}`,
    queued.ranAt > 0 && queued.afterRelease,
  );
  row(
    'группа: конец команды отдал место',
    'своих аренд нет',
    JSON.stringify(queued.leasesLeft),
    queued.leasesLeft.length === 0,
  );
  row(
    'контроль (обычный разговор): гейт пошёл сразу',
    'запуск ДО освобождения',
    `запуск через ${control.waitedMs} мс, после освобождения: ${control.afterRelease}`,
    control.exit === 0 && control.ranAt > 0 && !control.afterRelease,
  );
  row('контроль: очереди в слое нет', 'нет', String(control.queueEnv), control.queueEnv === null);
  if (!rows.every((r) => r.ok)) console.log('stderr:', queued.stderr, '|', control.stderr);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`qwen ${version}`);
for (const r of rows) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.what}: ожидали ${r.expected}; вышло ${r.actual}`);
}
const failed = rows.filter((r) => !r.ok).length;
console.log(
  failed ? `ПРОВАЛ: ${failed} из ${rows.length}` : `ВСЁ ЗЕЛЁНОЕ: ${rows.length} проверок`,
);
process.exit(failed ? 1 : 0);
