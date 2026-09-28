/**
 * Dev-сторож сервера вместо `node --watch` (журнал 26, 10, 71, 69c).
 *
 * Почему не `node --watch`. На Windows он слушает каталоги через
 * ReadDirectoryChangesW с флагом «последний доступ», а NTFS обновляет время
 * доступа не чаще раза в час. Сторож панели (`tools/keepalive.mjs`) раз в пять
 * минут поднимается планировщиком и импортирует `brand.mjs` — файл из графа
 * модулей сервера: чтение сдвигало atime, и панель перезапускалась примерно раз
 * в час без единой правки. Импорт из сторожа не убран: `brand.mjs` — одна копия
 * правды о бренде, её читают и мосты `tools/mcp`.
 *
 * Что делает этот сторож:
 * - перезапускает сервер только при настоящей правке: изменились время записи
 *   или размер, файл появился или исчез; чтение файла перезапуском не считается;
 * - тесты, фикстуры, объявления типов, .md и всё вне кода не смотрит;
 * - собирает правки пачкой (пауза `DEBOUNCE_MS`), а не перезапускает на каждую;
 * - валит только процесс сервера, не дерево (ни `taskkill /T`, ни группы):
 *   посредники живых сессий (`live-relay.mjs`) отвязаны и переживают
 *   перезапуск вместе с CLI; запущенный с IPC уходит вместе с родителем;
 * - откладывает перезапуск, пока в журнале прогонов есть идущий ход с живым
 *   процессом (не дольше `DEFER_CAP_MS`): поток хода не рвётся на середине.
 *   `AGENTDECK_DEV_DEFER=0` — перезапускать сразу;
 * - прежде чем погасить работающий сервер, пробует новую сборку
 *   (`dev-boot-probe.mjs`): не поднимается — прежний сервер работает дальше,
 *   а в журнал уходит файл и строка ошибки;
 * - упавший сам сервер поднимает снова (паузы `RELAUNCH_DELAYS_MS`): панель не
 *   остаётся пустой до следующей правки, а посредники чатов — без сервера.
 */
/* global process, setTimeout, clearTimeout, console, URL */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appDataDirOf } from './brand.mjs';

const CODE = new Set(['.ts', '.mts', '.mjs', '.js', '.json']);
const SKIP_DIRS = new Set(['node_modules', '__fixtures__', 'coverage', 'dist']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/;
const DEBOUNCE_MS = 300;
const DEFER_POLL_MS = 5_000;
const DEFER_CAP_MS = 10 * 60_000;

/** Правка этого файла может изменить поведение сервера. */
export function isWatched(path) {
  const parts = path.split(/[\\/]/);
  const name = parts.at(-1) ?? '';
  if (parts.slice(0, -1).some((part) => SKIP_DIRS.has(part) || part.startsWith('.'))) {
    return false;
  }
  if (TEST_FILE.test(name) || name.endsWith('.d.ts') || name.endsWith('.d.mts')) return false;
  // Слепки для тестов, не данные сервера.
  if (name.endsWith('.pins.json')) return false;
  return CODE.has(extname(name));
}

/** Отпечаток файла без времени доступа: его сдвигает любое чтение. */
function stamp(path) {
  try {
    const stat = statSync(path);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : undefined;
  } catch {
    return undefined;
  }
}

function scan(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) scan(full, out);
    } else if (isWatched(full)) {
      const current = stamp(full);
      if (current) out.set(full, current);
    }
  }
  return out;
}

/**
 * Слушает каталоги и зовёт `onChange` с пачкой путей, у которых изменилось
 * содержимое. Событие без правки (atime, атрибуты, повтор) гасится сверкой
 * отпечатков.
 */
export class SourceWatcher {
  constructor(roots, onChange, debounceMs = DEBOUNCE_MS) {
    this.roots = roots;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    this.stamps = new Map();
    this.pending = new Set();
    this.watchers = [];
    this.timer = undefined;
  }

  start() {
    for (const root of this.roots) {
      scan(root, this.stamps);
      try {
        const watcher = watch(root, { recursive: true }, (_event, name) =>
          name ? this.touched(join(root, String(name))) : this.rescan(root),
        );
        watcher.on('error', () => undefined);
        this.watchers.push(watcher);
      } catch {
        // Каталога нет (пакет контрактов не собран) — смотреть нечего.
      }
    }
    return this;
  }

  close() {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  touched(path) {
    if (!isWatched(path)) return;
    const current = stamp(path);
    if (current === this.stamps.get(path)) return;
    if (current === undefined) this.stamps.delete(path);
    else this.stamps.set(path, current);
    this.pending.add(path);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Событие без имени файла — сверяем весь каталог. */
  rescan(root) {
    const fresh = scan(root, new Map());
    for (const path of new Set([...fresh.keys(), ...this.stamps.keys()])) {
      if (path.startsWith(root)) this.touched(path);
    }
  }

  flush() {
    const files = [...this.pending];
    this.pending.clear();
    if (files.length) this.onChange(files);
  }
}

/** Идёт ли ход: запись журнала не ждущая, и её процесс жив. */
export function busyRun(entries, isAlive) {
  return entries.some(
    (entry) => entry && !entry.idle && typeof entry.pid === 'number' && isAlive(entry.pid),
  );
}

function readEntries(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

const PROBE_SCRIPT = fileURLToPath(new URL('./dev-boot-probe.mjs', import.meta.url));
const PROBE_TIMEOUT_MS = 90_000;
/** Паузы перед подъёмом упавшего сервера: первая короткая, дальше реже. */
const RELAUNCH_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Проживший столько сервер упал не при загрузке — отсчёт пауз заново. */
const STABLE_MS = 60_000;

/** Пауза перед `attempt`-й попыткой подряд поднять упавший сервер. */
export function relaunchDelay(attempt) {
  return RELAUNCH_DELAYS_MS[Math.min(attempt, RELAUNCH_DELAYS_MS.length - 1)];
}

/**
 * Поднимается ли код сервера — проба графа модулей в отдельном процессе
 * (`dev-boot-probe.mjs`), без порта и без подхвата сессий. `output` — хвост
 * stderr пробы: в нём файл и строка ошибки.
 */
export function probeBuild(serverDir, entry = 'src/index.ts', timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((done) => {
    const probe = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', PROBE_SCRIPT, entry],
      { cwd: serverDir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    let output = '';
    probe.stderr.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-4_000);
    });
    const timer = setTimeout(() => {
      output += `\nпроба не уложилась в ${timeoutMs / 1000} с`;
      probe.kill();
    }, timeoutMs);
    probe.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, output: error.message });
    });
    probe.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, output: output.trim() });
    });
  });
}

function main() {
  const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const roots = [
    join(serverDir, 'src'),
    resolve(serverDir, '..', '..', 'packages', 'contracts', 'src'),
  ];
  const configRoot = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const ledgerFile = join(appDataDirOf(configRoot), 'runs.json');
  const defer = process.env.AGENTDECK_DEV_DEFER !== '0';
  const log = (line) => console.log(`[dev-watch] ${line}`);
  const pending = new Set();
  let child;
  let deferredSince;
  let timer;
  let relaunchTimer;
  let crashes = 0;
  let waitingEdit = false;
  let probing = false;
  let again = false;

  const launch = () => {
    const startedAt = Date.now();
    child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
      cwd: serverDir,
      stdio: 'inherit',
    });
    const current = child;
    current.on('exit', (code, signal) => {
      if (current !== child) return;
      // Сервер упал сам (не сторож его погасил): панель без него пуста, а
      // посредники чатов ждут, пока к ним подключатся, — поднимаем снова.
      child = undefined;
      if (Date.now() - startedAt >= STABLE_MS) crashes = 0;
      const delay = relaunchDelay(crashes);
      crashes += 1;
      log(`сервер вышел (${code ?? signal}), поднимаю снова через ${delay / 1000} с`);
      clearTimeout(relaunchTimer);
      relaunchTimer = setTimeout(() => void relaunch(), delay);
    });
  };

  /**
   * Подъём после падения: сломанный код поднимать незачем — ждём правку. Но
   * проба падает и не из-за кода (таймаут под нагрузкой, сбой запуска), и
   * ждать правку вечно тогда нельзя (F-199): проба повторяется с растущей
   * паузой, а правка перезапустит раньше. Полный текст сбоя — один раз.
   */
  const relaunch = async () => {
    if (child) return;
    const probe = await probeBuild(serverDir);
    if (child) return;
    if (!probe.ok) {
      const delay = relaunchDelay(crashes);
      crashes += 1;
      log(
        waitingEdit
          ? `проба снова не прошла, повторю через ${delay / 1000} с`
          : `новая сборка не поднимается — жду правку, проба повторится через ${delay / 1000} с:\n${probe.output}`,
      );
      waitingEdit = true;
      clearTimeout(relaunchTimer);
      relaunchTimer = setTimeout(() => void relaunch(), delay);
      return;
    }
    waitingEdit = false;
    launch();
  };

  const restart = async () => {
    clearTimeout(timer);
    if (probing) {
      again = true;
      return;
    }
    const now = Date.now();
    if (defer && busyRun(readEntries(ledgerFile), pidAlive)) {
      deferredSince ??= now;
      if (now - deferredSince < DEFER_CAP_MS) {
        if (now === deferredSince)
          log(`правки ждут конца идущих ходов (до ${DEFER_CAP_MS / 60_000} мин)`);
        timer = setTimeout(restart, DEFER_POLL_MS);
        return;
      }
    }
    deferredSince = undefined;
    const files = [...pending];
    pending.clear();
    const named = `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` и ещё ${files.length - 3}` : ''}`;
    // Сначала проба: сломанная правка не имеет права погасить работающий сервер.
    probing = true;
    const probe = await probeBuild(serverDir);
    probing = false;
    if (again) {
      // Пока шла проба, пришли ещё правки — проверяем уже их вместе с этими.
      again = false;
      for (const file of files) pending.add(file);
      void restart();
      return;
    }
    if (!probe.ok) {
      log(
        `новая сборка не поднимается — ${child ? 'работает прежняя' : 'жду правку'} (${named}):\n${probe.output}`,
      );
      return;
    }
    log(`перезапуск: ${named}`);
    clearTimeout(relaunchTimer);
    crashes = 0;
    waitingEdit = false;
    const old = child;
    child = undefined;
    if (old && old.exitCode === null && old.signalCode === null) {
      old.once('exit', launch);
      old.kill();
    } else {
      launch();
    }
  };

  new SourceWatcher(roots, (files) => {
    for (const file of files) pending.add(file);
    if (deferredSince === undefined) void restart();
  }).start();
  launch();
  const stop = () => {
    const current = child;
    child = undefined;
    clearTimeout(relaunchTimer);
    current?.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Запущен с каналом IPC (проверки, чужой пусковой скрипт) — уходит вместе с
  // тем, кто запустил: на Windows сигналов у Node нет, и иначе снять сторожа
  // с его сервером можно было только деревом (`taskkill /T`), а дерево по
  // номеру родителя цепляет чужие процессы, чей давно умерший родитель носил
  // тот же номер. Здесь гаснет ровно свой сервер, по своему номеру.
  if (process.send) process.on('disconnect', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
