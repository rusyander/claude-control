/**
 * Сторож панели: следит, что обе половины `pnpm dev` живы, и поднимает упавшую.
 *
 * Зачем он вообще нужен. Панель — единственный dev-стенд, который на этой
 * машине живёт постоянно, а всё вокруг считает долгоживущий dev-сервер мусором:
 * дерево `pnpm dev` растёт из шелла, который давно закрылся, поэтому для любого
 * уборщика процессов оно выглядит сиротой. Убили родителя — половина стенда
 * осталась без надзора: `node --watch` уже не поднимет упавший API, а vite без
 * своего `cmd` просто исчезает. Снаружи это и выглядит как «панель сама
 * выключилась»: то фронт молчит, то API, то всё сразу.
 *
 * Что делает. Раз в 20 секунд стучится в 127.0.0.1:5178 и 127.0.0.1:8888 —
 * именно TCP-коннектом, а не HTTP-запросом: при включённом гейте токена живая
 * панель отвечает 401, и считать это смертью было бы враньём. Две тишины подряд
 * (после стартовой паузы) — перезапуск ровно той половины, которая молчит,
 * с нарастающей паузой, чтобы не долбиться в цикле по мёртвому порту.
 *
 * Живую панель НЕ трогает: если порт отвечает уже на старте, сторож просто
 * берёт её под наблюдение — иначе он подрался бы за порт с запущенным `pnpm dev`.
 *
 *   pnpm keepalive           запустить в этом окне (Ctrl+C — выход, стенд гасится)
 *   pnpm keepalive:install   автозапуск: «Автозагрузка» + подхват раз в 5 минут
 *   pnpm keepalive:off       снять автозапуск
 *   pnpm keepalive:status    что сейчас живо
 *
 * Автозапуск двухслойный и весь пользовательский, без UAC: ярлык в
 * «Автозагрузке» поднимает сторож при входе в систему, задача планировщика раз
 * в 5 минут поднимает его же, если он умер. Окна не будет — обе точки идут
 * через `keepalive-hidden.vbs`. Дублей не будет: pid-файл в
 * %LOCALAPPDATA%\claude-control\ заставляет лишний экземпляр молча выйти.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = platform() === 'win32';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Системные утилиты берём по полному пути: без расширения spawn на Windows
// отдаёт EPERM, а PATH под Git Bash до них не всегда доводит.
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const SCHTASKS = WIN ? join(SYSTEM32, 'schtasks.exe') : 'schtasks';
const TASKKILL = WIN ? join(SYSTEM32, 'taskkill.exe') : 'taskkill';
const NETSTAT = WIN ? join(SYSTEM32, 'netstat.exe') : 'netstat';
const WSCRIPT = join(SYSTEM32, 'wscript.exe');

/** Половины стенда. Порт — единственный надёжный признак жизни. */
const UNITS = [
  { id: 'server', port: Number(process.env.PORT ?? 5178), filter: '@claude-control/server' },
  { id: 'web', port: Number(process.env.WEB_PORT ?? 8888), filter: '@claude-control/web' },
];

const PROBE_MS = 20_000;
/** Холодный старт vite и `node --watch` — секунды, но на занятой машине десятки. */
const GRACE_MS = 90_000;
const FAILS_TO_RESTART = 2;
const BACKOFF_MIN_MS = 15_000;
const BACKOFF_MAX_MS = 300_000;
/** Столько прожил без падений — прошлые неудачи больше не в счёт. */
const HEALTHY_RESET_MS = 600_000;

const STATE_DIR = WIN
  ? join(process.env.LOCALAPPDATA ?? homedir(), 'claude-control')
  : join(homedir(), '.claude-control');
const LOG_PATH = join(STATE_DIR, 'keepalive.log');
const PID_PATH = join(STATE_DIR, 'keepalive.pid');
const LOG_MAX_BYTES = 2 * 1024 * 1024;

const TASK_MAIN = 'ClaudeControlKeepalive';
const TASK_WATCH = 'ClaudeControlKeepaliveWatch';

function log(line) {
  // Местное время, а не UTC: журнал читает человек и сверяет его со своими
  // «панель отвалилась около полудня», а не с гринвичем.
  const stamp = new Date().toLocaleString('sv-SE');
  const text = `${stamp}  ${line}\n`;
  process.stdout.write(text);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // Обрезаем целиком, а не половину: это журнал перезапусков, а не улика.
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES)
      writeFileSync(LOG_PATH, '');
    appendFileSync(LOG_PATH, text);
  } catch {
    // Журнал — удобство, а не условие работы: не пишется, значит не пишется.
  }
}

/** Живой TCP-слушатель на петле. Ответ HTTP не спрашиваем — см. шапку файла. */
function probe(port) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(alive);
    };
    socket.setTimeout(2_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Погасить дерево процессов целиком: pnpm → cmd → vite/node. */
function killTree(pid) {
  try {
    if (WIN) execFileSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch {
    // Уже мёртв — ровно тот случай, ради которого мы сюда и пришли.
  }
}

/**
 * Кто слушает порт на петле, или 0. Нужен ровно за одним: у стенда, который
 * сторож взял под наблюдение, а не запускал сам, нет дочернего процесса — и без
 * этого его остаток нечем погасить.
 */
function listenerPid(port) {
  try {
    if (WIN) {
      const out = execFileSync(NETSTAT, ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      for (const line of out.split(/\r?\n/)) {
        const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
        if (match && Number(match[1]) === port) return Number(match[2]);
      }
    } else {
      const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
      });
      return Number(out.split(/\s+/).filter(Boolean)[0]) || 0;
    }
  } catch {
    // Слушателя нет либо утилиты нет — и то и другое значит «гасить нечего».
  }
  return 0;
}

// === Запуск и остановка половины стенда ===

function start(unit) {
  // На Windows зовём cmd.exe явной строкой, а не `shell: true` с массивом:
  // на массиве Node пишет DEP0190 и склеивает аргументы без экранирования.
  // Так же запускает свои скрипты и сам pnpm — `cmd /d /s /c vite`.
  const [command, args] = WIN
    ? [join(SYSTEM32, 'cmd.exe'), ['/d', '/s', '/c', `pnpm --filter ${unit.filter} dev`]]
    : ['pnpm', ['--filter', unit.filter, 'dev']];
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: !WIN,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  unit.child = child;
  unit.startedAt = Date.now();
  unit.failures = 0;
  unit.stderrLines = 0;

  // Поток ошибок пишем в журнал, но с потолком: иначе первый же сломанный
  // импорт превратит журнал в лог сборки и утопит в себе историю перезапусков.
  child.stderr?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim() || unit.stderrLines >= 20) continue;
      unit.stderrLines += 1;
      log(`${unit.id}: ${line.trim()}`);
    }
  });
  child.once('error', (error) => log(`${unit.id}: не удалось запустить — ${error.message}`));
  child.once('exit', (code, signal) => {
    if (unit.child === child) unit.child = null;
    log(`${unit.id}: процесс завершился (code=${code ?? '—'} signal=${signal ?? '—'})`);
  });

  log(`${unit.id}: запущен, pnpm --filter ${unit.filter} dev (pid ${child.pid})`);
}

/**
 * Гасим ТОЛЬКО то, что запускали сами. Взятый под наблюдение чужой стенд здесь
 * не трогаем: этим же путём идёт выход по Ctrl+C, а забирать с собой живую
 * панель, которую подняли руками, сторож не вправе.
 */
function stop(unit) {
  const child = unit.child;
  unit.child = null;
  if (child?.pid) killTree(child.pid);
}

/**
 * Остаток стенда, взятого под наблюдение. Порт уже молчит, но само дерево может
 * быть живо наполовину: уборщик процессов срубает `pnpm`/`cmd`, а `node --watch`
 * под ними выживает — и на первой же правке файла снова займёт порт, теперь уже
 * дерясь за него со свежим стендом. Поэтому перед подъёмом замены добиваем его.
 */
function dropAdopted(unit) {
  const pid = unit.adoptedPid;
  unit.adoptedPid = 0;
  if (!pid || !pidAlive(pid)) return;
  log(`${unit.id}: добиваю остаток прежнего стенда (pid ${pid})`);
  killTree(pid);
}

function restart(unit) {
  const wait = unit.backoffMs ?? BACKOFF_MIN_MS;
  if (unit.nextStartAt && Date.now() < unit.nextStartAt) return;
  log(`${unit.id}: порт ${unit.port} молчит — перезапуск`);
  stop(unit);
  dropAdopted(unit);
  start(unit);
  unit.backoffMs = Math.min(wait * 2, BACKOFF_MAX_MS);
  unit.nextStartAt = Date.now() + wait;
}

async function tick() {
  for (const unit of UNITS) {
    const alive = await probe(unit.port);
    if (alive) {
      unit.failures = 0;
      if (!unit.healthySince) unit.healthySince = Date.now();
      if (Date.now() - unit.healthySince > HEALTHY_RESET_MS) unit.backoffMs = BACKOFF_MIN_MS;
      continue;
    }
    unit.healthySince = 0;
    // Молодой процесс ещё поднимается — это не смерть, это старт.
    if (unit.startedAt && Date.now() - unit.startedAt < GRACE_MS) continue;
    unit.failures = (unit.failures ?? 0) + 1;
    if (unit.failures >= FAILS_TO_RESTART) restart(unit);
  }
}

// === Автозапуск ===

function schtasks(args) {
  return execFileSync(SCHTASKS, args, { encoding: 'utf8', windowsHide: true });
}

function taskAction() {
  const vbs = join(ROOT, 'tools', 'keepalive-hidden.vbs');
  const script = join(ROOT, 'tools', 'keepalive.mjs');
  return `"${WSCRIPT}" "${vbs}" "${process.execPath}" "${script}"`;
}

/** Ярлык в «Автозагрузке» текущего пользователя. */
function startupFile() {
  const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(
    base,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'claude-control-keepalive.vbs',
  );
}

function install() {
  if (!WIN) {
    console.error(
      'Автозапуск сделан под Windows. На других системах: pnpm keepalive под supervisor/systemd.',
    );
    process.exit(1);
  }
  const action = taskAction();

  // Вход в систему держим на «Автозагрузке», а не на задаче /sc ONLOGON:
  // триггер логона планировщик отдаёт только администратору, а панель — вещь
  // пользовательская, просить ради неё UAC не за что.
  const startup = startupFile();
  mkdirSync(dirname(startup), { recursive: true });
  // Строковый литерал VBScript: кавычка внутри удваивается, обратные слеши
  // не экранируются. JSON.stringify здесь давал \" и \\ — WSH падал с ошибкой
  // компиляции 800A0401 при каждом входе в систему (06.09.2026).
  const vbsString = (s) => `"${s.replace(/"/g, '""')}"`;
  writeFileSync(
    startup,
    `CreateObject("WScript.Shell").Run ${vbsString(action)}, 0, False\r\n`,
    'utf8',
  );

  // Вторая линия: задача раз в 5 минут поднимает САМ сторож, если тот умер
  // (упал, убит уборщиком, снят руками). Лишний экземпляр молча выходит по
  // pid-файлу, так что холостой запуск ничего не стоит и ничего не ломает.
  schtasks(['/create', '/tn', TASK_WATCH, '/tr', action, '/sc', 'MINUTE', '/mo', '5', '/f']);
  schtasks(['/run', '/tn', TASK_WATCH]);

  console.log(`\n✓ Сторож установлен.

  Автозагрузка   ${startup}
  ${TASK_WATCH}  — подхват раз в 5 минут, если сторож умер

  Журнал:  ${LOG_PATH}
  Статус:  pnpm keepalive:status
  Снять:   pnpm keepalive:off
`);
}

function uninstall() {
  for (const name of [TASK_MAIN, TASK_WATCH]) {
    try {
      schtasks(['/delete', '/tn', name, '/f']);
    } catch {
      // Задачи нет — цель уже достигнута.
    }
  }
  try {
    rmSync(startupFile(), { force: true });
  } catch {
    // Ярлыка нет — тоже нормально.
  }
  try {
    const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
    if (pid && pidAlive(pid)) {
      if (WIN) execFileSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
    }
  } catch {
    // Не запущен — тоже нормально.
  }
  console.log('\n✓ Задачи сняты, сторож остановлен. Сама панель продолжает работать.\n');
}

async function status() {
  const lines = [];
  for (const unit of UNITS) {
    const alive = await probe(unit.port);
    lines.push(
      `  ${unit.id.padEnd(7)} 127.0.0.1:${unit.port}  ${alive ? '✓ отвечает' : '✕ молчит'}`,
    );
  }
  let watchdog = '✕ не запущен';
  try {
    const pid = Number(readFileSync(PID_PATH, 'utf8').trim());
    if (pid && pidAlive(pid)) watchdog = `✓ работает (pid ${pid})`;
  } catch {
    // Файла нет — сторож не запускался.
  }
  console.log(`\n${lines.join('\n')}\n  сторож  ${watchdog}\n  журнал  ${LOG_PATH}\n`);
}

// === Точка входа ===

const mode = process.argv[2] ?? '';
if (mode === '--install') {
  install();
} else if (mode === '--uninstall' || mode === '--off') {
  uninstall();
} else if (mode === '--status') {
  await status();
} else {
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    const running = Number(readFileSync(PID_PATH, 'utf8').trim());
    if (running && running !== process.pid && pidAlive(running)) {
      // В журнал НЕ пишем: задача-подхват приходит каждые 5 минут, и штатный
      // «уже работает» за сутки утопил бы в себе историю перезапусков.
      process.stdout.write(`сторож уже работает (pid ${running}) — выхожу\n`);
      process.exit(0);
    }
  } catch {
    // Первый запуск.
  }
  writeFileSync(PID_PATH, String(process.pid));

  log(`сторож поднялся, корень ${ROOT}`);
  for (const unit of UNITS) {
    if (await probe(unit.port)) {
      unit.healthySince = Date.now();
      // Запоминаем владельца порта: своего процесса у такого стенда нет, и без
      // этого его остаток потом нечем будет погасить (см. `dropAdopted`).
      unit.adoptedPid = listenerPid(unit.port);
      log(
        `${unit.id}: порт ${unit.port} уже занят${unit.adoptedPid ? ` (pid ${unit.adoptedPid})` : ''} — беру под наблюдение, не перезапускаю`,
      );
    } else {
      start(unit);
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, PROBE_MS);

  const shutdown = () => {
    clearInterval(timer);
    for (const unit of UNITS) stop(unit);
    try {
      rmSync(PID_PATH, { force: true });
    } catch {
      // Файл уже убран.
    }
    log('сторож остановлен');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
