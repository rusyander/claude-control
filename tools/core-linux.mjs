/**
 * Набор `apps/core` на Linux с машины Windows (09 §OS coverage, P60): одноразовый контейнер
 * из сохранённого образа `agentdeck-core-linux:22` (node:22 bookworm + git + procps + pnpm).
 *
 *   node tools/core-linux.mjs [vitest args…]   # без аргументов — весь набор apps/core
 *   node tools/core-linux.mjs src/platform/tree-stop.test.ts --reporter=verbose
 *   node tools/core-linux.mjs --rebuild         # пересобрать образ (иначе берётся сохранённый)
 *   node tools/core-linux.mjs --mutants plan.json  # мутанты POSIX-свойств по копии в контейнере
 *   node tools/core-linux.mjs --coverage-out <file>  # весь набор + карта покрытия Linux наружу
 *   node tools/core-linux.mjs --engine src/conductor/services.test.ts  # + движок хоста (09:48)
 *   node tools/core-linux.mjs --clis src/adapters/gemini  # + Gemini CLI, Kimi CLI, Cursor Agent (этап 10)
 *
 * `--engine` (фаза 3, сервисы в контейнерах): образ `agentdeck-core-linux:22-engine` — тот же
 * плюс docker CLI — и сокет движка хоста внутрь (`/var/run/docker.sock`, группа 0 для
 * пользователя `node`). Контейнеры, которые поднимут тесты, — соседи на хосте, не вложенные; их
 * метки (`claude.ephemeral=1`) и снятие — дело тестов. Без флага сокета нет: набор других зон не
 * видит движка и не начинает поднимать контейнеры сам.
 *
 * Рабочая копия КОПИРУЕТСЯ внутрь архивом (манифесты воркспейса + `apps/core` +
 * `packages/*` + замыкание импортов прокладки панели для P23, без node_modules), зависимости
 * ставятся внутри — Linux-сборки
 * нативных пакетов не смешиваются с Windows-деревом. Контейнер `--rm --init` (init собирает
 * зомби: тесты остановки дерева их порождают), метка `claude.ephemeral=1`, без именованных
 * томов; тесты идут от пользователя `node`, не root (права и exec-бит проверяются как у
 * человека). После основного прогона — второй проход `*.alone.test.ts` поодиночке с тем же
 * фильтром (`AGENTDECK_CORE_ALONE=1`, vitest.config.ts). В конце — чтение назад: контейнера с этим
 * именем больше нет.
 * macOS отсюда не запустить: там только разбор записанного вывода, отчёт — «not run on macOS».
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeMutation, foreignMutation } from './mutation-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'agentdeck-core-linux:22';
const NAME = `agentdeck-core-linux-${process.pid}-${Date.now()}`;

const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const withEngine = args.includes('--engine');
const ENGINE_IMAGE = `${IMAGE}-engine`;
// `--clis` — образ с CLI, которых нет на машине разработки (этап 10): Gemini CLI (npm),
// Kimi Code (установщик вендора; прежний `kimi-cli` из PyPI вендор закрыл), Cursor Agent
// (установщик вендора, версию не прибить). Версии прибиты в имени образа: сменилась — новый
// образ строится сам, запись потока живого CLI годится, только пока известно, чем она снята.
const withClis = args.includes('--clis');
const CLI_PINS = { gemini: '0.66.0', kimi: '2.4.1' };
const CLIS_IMAGE = `${IMAGE}-clis-g${CLI_PINS.gemini}-k${CLI_PINS.kimi}`;
// `--mutants <plan.json>` — прогон плана мутантов в контейнере (core-linux-mutants.mjs).
const mutantsAt = args.indexOf('--mutants');
const mutantPlan =
  mutantsAt >= 0 ? Buffer.from(readFileSync(args[mutantsAt + 1], 'utf8')).toString('base64') : '';
// `--coverage-out <file>` — карта покрытия Linux (coverage-final.json) наружу для слитого
// порога (core-coverage-merge.mjs). Контейнер `--rm`, тома не монтируются (см. copyList) —
// карта выходит через stdout контейнера: весь прочий вывод внутри уходит в stderr.
const coverageAt = args.indexOf('--coverage-out');
const coverageOut = coverageAt >= 0 ? resolve(args[coverageAt + 1]) : '';
const valued = new Set(
  [mutantsAt, coverageAt].filter((at) => at >= 0).flatMap((at) => [at, at + 1]),
);
const vitestArgs = args.filter(
  (arg, index) =>
    arg !== '--rebuild' && arg !== '--engine' && arg !== '--clis' && !valued.has(index),
);

function docker(argv, options = {}) {
  return spawnSync('docker', argv, { encoding: 'utf8', windowsHide: true, ...options });
}

function pnpmVersion() {
  const manager = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).packageManager ?? '';
  const match = /^pnpm@([\d.]+)/.exec(manager);
  return match ? match[1] : '10';
}

function ensureImage() {
  const present = docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']).status === 0;
  if (present && !rebuild) return;
  const dockerfile = [
    'FROM node:22-bookworm-slim',
    'RUN apt-get update && apt-get install -y --no-install-recommends git procps ca-certificates && rm -rf /var/lib/apt/lists/*',
    `RUN corepack enable && corepack install -g pnpm@${pnpmVersion()}`,
    'ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    'LABEL agentdeck.purpose="core-linux-tests"',
    '',
  ].join('\n');
  console.log(`[core-linux] building ${IMAGE} (kept for next runs)`);
  const built = docker(['build', '-t', IMAGE, '-'], {
    input: dockerfile,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (built.status !== 0) {
    console.error('[core-linux] image build failed');
    process.exit(2);
  }
}

/** Образ с docker CLI поверх основного: CLI берётся из официального `docker:29-cli`, не из apt. */
function ensureEngineImage() {
  const present = docker(['image', 'inspect', ENGINE_IMAGE, '--format', '{{.Id}}']).status === 0;
  if (present && !rebuild) return;
  const dockerfile = [
    `FROM ${IMAGE}`,
    'COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker',
    'LABEL agentdeck.purpose="core-linux-tests-engine"',
    '',
  ].join('\n');
  console.log(`[core-linux] building ${ENGINE_IMAGE} (kept for next runs)`);
  const built = docker(['build', '-t', ENGINE_IMAGE, '-'], {
    input: dockerfile,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (built.status !== 0) {
    console.error('[core-linux] engine image build failed');
    process.exit(2);
  }
}

/** Образ с чужими CLI поверх основного (третий хранимый). Установки — от `node`, как у человека. */
function ensureClisImage() {
  const present = docker(['image', 'inspect', CLIS_IMAGE, '--format', '{{.Id}}']).status === 0;
  if (present && !rebuild) return;
  const dockerfile = [
    `FROM ${IMAGE}`,
    'RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*',
    `RUN npm i -g @google/gemini-cli@${CLI_PINS.gemini} && npm cache clean --force`,
    'USER node',
    'ENV PATH=/home/node/.local/bin:/home/node/.kimi-code/bin:$PATH',
    `RUN curl -fsSL https://code.kimi.com/kimi-code/install.sh | KIMI_VERSION=${CLI_PINS.kimi} bash`,
    'RUN curl -fsS https://cursor.com/install | bash',
    'USER root',
    'LABEL agentdeck.purpose="core-linux-tests-clis"',
    '',
  ].join('\n');
  console.log(`[core-linux] building ${CLIS_IMAGE} (kept for next runs)`);
  const built = docker(['build', '-t', CLIS_IMAGE, '-'], {
    input: dockerfile,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (built.status !== 0) {
    console.error('[core-linux] clis image build failed');
    process.exit(2);
  }
}

function quote(arg) {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Что копируется внутрь: манифесты всех пакетов воркспейса (lockfile их перечисляет) +
 * исходники ядра и общих пакетов; node_modules, coverage и .git — нет. Копия идёт архивом
 * через stdin, не монтированием: Docker Desktop на Windows отказывает в bind-монтировании
 * диска (`mkdir /run/desktop/mnt/host/c: file exists`, замер 28.10), а чтение архива от
 * этого не зависит.
 */
/**
 * Тесты ядра, которые поднимают кусок панели отдельным процессом (P23: прокладка
 * `apps/server/src/routes/core-proxy`), — их входы. Внутрь идёт только замыкание
 * относительных импортов от входа, а не весь `apps/server/src` (~40 МБ): pid пира читается
 * по-разному на каждой ОС, и Linux должен судить настоящий код прокладки. `dev-watch.mjs` и
 * `dev-boot-probe.mjs` копирует в одноразовый корень тест P131 (запись звена панели при
 * перезапуске): без них в копии он падал на ENOENT, а не на поведении.
 */
const PANEL_ENTRIES = [
  'apps/server/src/routes/core-proxy/__fixtures__/proxy-host.ts',
  'apps/server/src/lib/dev-watch.mjs',
  'apps/server/src/lib/dev-boot-probe.mjs',
  // Мост панели вопроса ядра (`bootstrap/ask.integration.test.ts`): MCP SDK он берёт из
  // зависимостей `apps/server` — они в контейнере ставятся (`--filter @agentdeck/server...`).
  'tools/mcp/panel.mjs',
  // `tests-cli delivery` процессом (`publish-wiring/delivery.cli.integration.test.ts`).
  'tools/tests-cli.mjs',
];

/**
 * Данные панели, которые тесты ядра читают как данные, а не импорт: записанная строка CLI
 * (окно лимита Claude, `adapters/claude/window.test.ts`) и шаблоны чата llama-server
 * (пометка отложенных инструментов, `hop-host/.../deferred-tools.test.ts`).
 */
const PANEL_DATA = [
  'apps/server/src/domains/chat/__fixtures__/stream-json-2.1.177.jsonl',
  'apps/server/src/domains/local-models/data/templates',
  // Настоящие файлы хуков набора панели — kit-hooks.test.ts (этап 11) собирает из них плагин.
  'apps/server/assets/kit/agentdeck-kit/.claude-plugin/plugin.json',
  'apps/server/assets/kit/agentdeck-kit/hooks/hooks.json',
];

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Файлы (от корня, через `/`), до которых доходят относительные импорты входов. */
function importClosure(root, entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) throw new Error(`[core-linux] import closure: ${rel} not found`);
    seen.add(rel);
    // Строки комментариев пропускаются: пример `import './x'` в комментарии — не импорт.
    const code = readFileSync(abs, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .join('\n');
    for (const [, spec] of code.matchAll(RELATIVE_IMPORT)) {
      queue.push(posix.normalize(posix.join(posix.dirname(rel), spec)));
    }
  }
  return [...seen].sort();
}

function copyList() {
  const list = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    if (existsSync(join(ROOT, 'apps', app, 'package.json'))) list.push(`apps/${app}/package.json`);
  }
  list.push('packages', 'apps/core');
  list.push(...importClosure(ROOT, PANEL_ENTRIES));
  for (const rel of PANEL_DATA) {
    if (!existsSync(join(ROOT, rel))) throw new Error(`[core-linux] panel data: ${rel} not found`);
    list.push(rel);
  }
  // Правила линта ядра проверяются тестом ядра (`*.lint.test.ts`) — без них он падает на импорте.
  if (existsSync(join(ROOT, 'tools', 'eslint-rules'))) list.push('tools/eslint-rules');
  // globalSetup ядра (vitest.config.ts); в копии без .git он видит «мутации нет».
  list.push('tools/mutation-guard.mjs');
  if (mutantPlan) list.push('tools/core-linux-mutants.mjs');
  return list;
}

function tarFile() {
  return process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

function containerScript() {
  const filters = vitestArgs.map(quote).join(' ');
  return [
    'set -e',
    // Карта покрытия наружу — только она идёт в stdout (fd 3), остальное в stderr.
    ...(coverageOut ? ['exec 3>&1 1>&2'] : []),
    'W=/home/node/w',
    'mkdir -p "$W"',
    'tar -xf - -C "$W"',
    'cd "$W"',
    'echo "[core-linux] $(node --version) pnpm $(pnpm --version) $(uname -sr)"',
    // Не frozen: соседний пакет рабочей копии может ещё не попасть в lockfile; правка lockfile
    // остаётся внутри одноразового контейнера и наружу не выходит.
    'CI=true pnpm install --no-frozen-lockfile --ignore-scripts --filter "@agentdeck/core..." --filter "@agentdeck/server..." --reporter=append-only > /tmp/install.log 2>&1 || { tail -40 /tmp/install.log; exit 3; }',
    'cd apps/core',
    ...(mutantPlan
      ? ['exec node ../../tools/core-linux-mutants.mjs']
      : [
          'set +e',
          ...(coverageOut
            ? [
                // Каталог назван явно: по умолчанию у прогона свой `coverage/run-<pid>` (vitest.coverage-dir.ts).
                `pnpm exec vitest run --coverage.reportsDirectory=coverage ${filters}`,
                'code=$?',
                '[ -f coverage/coverage-final.json ] && cat coverage/coverage-final.json >&3',
              ]
            : [`pnpm exec vitest run ${filters}`, 'code=$?']),
          // Второй проход — `*.alone.test.ts` поодиночке, когда соседей уже нет (vitest.config.ts);
          // фильтр тот же, файлов под ним может не быть.
          `AGENTDECK_CORE_ALONE=1 pnpm exec vitest run --passWithNoTests ${filters}`,
          'alone=$?',
          '[ "$code" -ne 0 ] && exit "$code"',
          'exit "$alone"',
        ]),
  ].join('\n');
}

function gone() {
  const left = docker(['ps', '-a', '--filter', `name=${NAME}`, '--format', '{{.Names}}']);
  return left.status === 0 && left.stdout.trim() === '';
}

// Копия снимается архивом с рабочего дерева: чужой живой mustfail в этот момент уехал бы в
// контейнер подменённым файлом, а guard внутри (копия без .git) его уже не увидит.
const mutation = foreignMutation({ cwd: ROOT });
if (mutation) {
  console.error(describeMutation(mutation));
  process.exit(4);
}
ensureImage();
if (withEngine) ensureEngineImage();
if (withClis) ensureClisImage();
if (withClis && withEngine) {
  console.error('[core-linux] --clis and --engine are separate images; pick one');
  process.exit(2);
}
let runImage = IMAGE;
if (withEngine) runImage = ENGINE_IMAGE;
if (withClis) runImage = CLIS_IMAGE;
// Сокет — путь внутри ВМ движка (Docker Desktop), не путь Windows: node передаёт его как есть.
const engineArgs = withEngine
  ? ['-v', '/var/run/docker.sock:/var/run/docker.sock', '--group-add', '0']
  : [];
const child = spawn(
  'docker',
  [
    'run',
    '--rm',
    '--init',
    '--label',
    'claude.ephemeral=1',
    '--name',
    NAME,
    '--user',
    'node',
    '-e',
    'HOME=/home/node',
    // Тест, которому нужно то, чего копия не несёт (`tools/` целиком, корневые зависимости), знает,
    // что идёт в ней, — и пропускается с причиной, а не падает на импорте.
    '-e',
    'AGENTDECK_CORE_LINUX_COPY=1',
    ...(mutantPlan ? ['-e', `MUTANT_PLAN=${mutantPlan}`] : []),
    ...engineArgs,
    '-i',
    runImage,
    'bash',
    '-c',
    containerScript(),
  ],
  { stdio: ['pipe', coverageOut ? 'pipe' : 'inherit', 'inherit'], windowsHide: true },
);
let coverageWritten = Promise.resolve();
if (coverageOut) {
  mkdirSync(dirname(coverageOut), { recursive: true });
  const sink = createWriteStream(coverageOut);
  child.stdout.pipe(sink);
  coverageWritten = new Promise((done) => sink.on('close', done));
}
const archive = spawn(
  tarFile(),
  ['-C', ROOT, '-cf', '-', '--exclude', 'node_modules', '--exclude', 'coverage', ...copyList()],
  { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
);
archive.stdout.pipe(child.stdin);
archive.on('close', (code) => {
  if (code !== 0) console.error(`[core-linux] archive of the working copy failed (exit ${code})`);
});

const stop = () => {
  docker(['rm', '-f', NAME]);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

child.on('close', async (code) => {
  await coverageWritten;
  let exitCode = code ?? 1;
  if (coverageOut) {
    // Пустой файл — покрытие было выключено (прогон не весь набор) или контейнер упал до карты:
    // пустая «карта» не остаётся на диске, иначе слияние приняло бы её за замер Linux (ревью m5).
    if (statSync(coverageOut).size === 0) {
      rmSync(coverageOut, { force: true });
      console.error(`[core-linux] no Linux coverage map produced; ${coverageOut} not written`);
      if (exitCode === 0) exitCode = 2;
    } else console.log(`[core-linux] Linux coverage map → ${coverageOut}`);
  }
  if (!gone()) {
    stop();
    console.error(`[core-linux] container ${NAME} was still present; removed`);
  }
  console.log(`[core-linux] container gone: ${gone()} · exit ${exitCode}`);
  console.log('[core-linux] macOS: not run on macOS (fixture parsers only)');
  process.exit(exitCode);
});
