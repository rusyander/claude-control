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
 * - собирает правки пачкой (тишина `QUIET_MS`, предел `MAX_WAIT_MS`), а не перезапускает на каждую;
 * - валит только процесс сервера, не дерево (ни `taskkill /T`, ни группы):
 *   посредники живых сессий (`live-relay.mjs`) отвязаны и переживают
 *   перезапуск вместе с CLI; запущенный с IPC уходит вместе с родителем;
 * - откладывает перезапуск, пока в журнале прогонов есть идущий ход с живым
 *   процессом или группа разделения готовит копию, — без предела: поток хода и
 *   `npm ci` копии не рвутся на середине (прежний потолок в 10 минут рвал их,
 *   решение 30.09). Пока правки ждут, панель видит это (`dev-restart.json`) и
 *   может попросить перезапуск сейчас (`dev-restart.request`).
 *   `AGENTDECK_DEV_DEFER=0` — перезапускать сразу;
 * - прежде чем погасить работающий сервер, пробует новую сборку
 *   (`dev-boot-probe.mjs`): не поднимается — прежний сервер работает дальше,
 *   а в журнал уходит файл и строка ошибки;
 * - упавший сам сервер поднимает снова (паузы `RELAUNCH_DELAYS_MS`): панель не
 *   остаётся пустой до следующей правки, а посредники чатов — без сервера.
 */
/* global process, setTimeout, clearTimeout, setInterval, console, URL */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appDataDirOf } from './brand.mjs';
import {
  appendDevLog,
  clearRestartState,
  deferReason,
  RUNS_WAIT_CAP_MS,
  runsWaitCapped,
  takeRestartRequest,
  writeRestartState,
} from './dev-restart.mjs';

const CODE = new Set(['.ts', '.mts', '.mjs', '.js', '.json']);
const SKIP_DIRS = new Set(['node_modules', '__fixtures__', 'coverage', 'dist']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/;
/**
 * Тишина перед перезапуском (владелец 25.10). Агент сохраняет файл раз в 6–60 с (журнал 23–24.10: медиана
 * 12 с), и прежняя пауза в 300 мс давала перезапуск на каждое сохранение: 897 за 23.10 и 363 за 24.10.
 * Пачка закрывается после `QUIET_MS` без правок, но не позже `MAX_WAIT_MS` от первой правки пачки — серия
 * правок не откладывает перезапуск без конца. Те же журналы через это окно — 83 и 73 перезапуска.
 * Не дожидаясь тишины — `pnpm dev:restart` (тот же `dev-restart.request`, что и у панели).
 */
export const QUIET_MS = Number(process.env.AGENTDECK_DEV_QUIET_MS) || 60_000;
export const MAX_WAIT_MS = Number(process.env.AGENTDECK_DEV_MAX_WAIT_MS) || 300_000;
const REQUEST_POLL_MS = 2_000;
const DEFER_POLL_MS = Number(process.env.AGENTDECK_DEV_DEFER_POLL_MS) || 5_000;
/** Предел ожидания ходов; `0` выключает его (ждать, как до 21.10, без предела). */
const RUNS_CAP_MS = process.env.AGENTDECK_DEV_RUNS_CAP_MS
  ? Math.max(0, Number(process.env.AGENTDECK_DEV_RUNS_CAP_MS) || 0)
  : RUNS_WAIT_CAP_MS;
/**
 * Журналы процессов проверок проекта в каталоге данных: имена — те же, что у
 * `project-tests/runs.ts` и `mutation.ts` (сторож исполняется голым Node и
 * `.ts` не подключает; совпадение держит тест).
 */
export const CHECK_LEDGERS = ['e2e-runs.json', 'project-test-runs.json', 'mutation-runs.json'];

/**
 * Журналы идущих ходов: Claude (`run-ledger.ts`) и чужие CLI
 * (`provider-chat/turn-ledger.ts`, F2: ход Codex/Qwen обрывался перезапуском).
 * Оба — ходы, с одним пределом ожидания; совпадение имён держит тест.
 */
export const RUN_LEDGERS = ['runs.json', 'provider-runs.json'];

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
  constructor(roots, onChange, quietMs = QUIET_MS, maxWaitMs = MAX_WAIT_MS) {
    this.roots = roots;
    this.onChange = onChange;
    this.quietMs = quietMs;
    this.maxWaitMs = maxWaitMs;
    this.stamps = new Map();
    this.pending = new Set();
    this.watchers = [];
    this.timer = undefined;
    this.firstAt = 0;
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
    const now = Date.now();
    if (!this.pending.size) this.firstAt = now;
    this.pending.add(path);
    clearTimeout(this.timer);
    const left = Math.max(0, this.firstAt + this.maxWaitMs - now);
    this.timer = setTimeout(() => this.flush(), Math.min(this.quietMs, left));
  }

  /** Пачка ждёт тишины. */
  waiting() {
    return this.pending.size > 0;
  }

  /** Закрыть пачку сейчас, не дожидаясь тишины (просьба о перезапуске). */
  flushNow() {
    clearTimeout(this.timer);
    this.flush();
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
  return entries.some((entry) => runGoing(entry, isAlive));
}

function runGoing(entry, isAlive) {
  return Boolean(entry && !entry.idle && typeof entry.pid === 'number' && isAlive(entry.pid));
}

/**
 * Идущие ходы по именам — папка прогона (у копии группы в ней ветка), без неё
 * ключ разговора: их называет панель, когда перезапуск по пределу их не дождётся.
 */
export function busyRunNames(entries, isAlive) {
  const names = entries
    .filter((entry) => runGoing(entry, isAlive))
    .map((entry) => (typeof entry.cwd === 'string' && entry.cwd ? basename(entry.cwd) : entry.key))
    .filter((name) => typeof name === 'string' && name);
  return [...new Set(names)];
}

/**
 * Ждать ли идущих ходов перед перезапуском (24.10, отказ от предела D1 21.10 для
 * живых ходов). Ход с живым процессом ждут без предела — ход группы разделения
 * тоже: перезапуск по пределу рвал поток хода посреди шага, и группа теряла
 * недоделанную работу. Предел `capMs` остаётся только у «занято», которое ничем
 * не доказано: журнал ходов не прочитался, а живого процесса в прочитанных нет —
 * иначе битый файл держал бы правки вечно. Нетерпеливому — кнопка в панели.
 * `ledgers` — результаты `readJsonSteady` журналов ходов; `capAt` — когда
 * перезапустит предел (есть только у недоказанного «занято»).
 */
export function runsWait(ledgers, isAlive, deferredSince, now, capMs) {
  const entries = ledgers.flatMap((ledger) => (Array.isArray(ledger?.value) ? ledger.value : []));
  const live = busyRun(entries, isAlive);
  const unproven = !live && ledgers.some((ledger) => ledger?.unreadable === true);
  const capped = unproven && runsWaitCapped(deferredSince, now, capMs);
  const wait = live || (unproven && !capped);
  const capAt =
    unproven && !capped && capMs > 0
      ? new Date((deferredSince ?? now) + capMs).toISOString()
      : undefined;
  return {
    wait,
    capped,
    ...(capAt ? { capAt } : {}),
    runs: live ? busyRunNames(entries, isAlive).slice(0, 5) : [],
  };
}

/** Подготовка копии старше этого — след процесса, умершего без перезапуска. */
const SETUP_STALE_MS = 30 * 60_000;

/**
 * Идёт ли подготовка копии у группы разделения: группа «стартует», а чата ещё
 * нет — панель заводит ветку и ставит зависимости (`npm ci` — минуты). В
 * журнале прогонов её не видно, прогона ещё нет; перезапуск посреди неё
 * оставлял группы без чата и с полузаведёнными копиями (живой прогон 29.09).
 */
export function splitSetupRunning(state, now) {
  const plans = state && typeof state === 'object' ? state.splitPlans : undefined;
  if (!plans || typeof plans !== 'object') return false;
  return Object.values(plans).some(
    (record) =>
      record &&
      !record.cancelledAt &&
      Array.isArray(record.groups) &&
      record.groups.some((group) => {
        if (!group || group.status !== 'started' || group.chatId) return false;
        const at = Date.parse(group.startedAt ?? '');
        return Number.isFinite(at) && now - at < SETUP_STALE_MS;
      }),
  );
}

const READ_ATTEMPTS = 5;
const READ_PAUSE_MS = 20;

/**
 * Чтение файла, который сервер переписывает атомарно (временный + переименование
 * поверх). На Windows чтение, попавшее в момент переименования, получает ENOENT:
 * при четырёх пишущих процессах так кончались ~4 % чтений (проба 20.10). Сторож
 * принимал такой промах за «ходов нет» и перезапускал сервер посреди живых ходов.
 * Поэтому промах повторяется; не прочиталось и после повторов — `unreadable`,
 * и это считается «занято»: лишняя отсрочка дешевле оборванного хода. Файла нет
 * на всех попытках — его правда нет (`value: undefined`).
 */
export function readJsonSteady(file, read = readFileSync, attempts = READ_ATTEMPTS) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { value: JSON.parse(read(file, 'utf8')) };
    } catch (error) {
      if (attempt >= attempts) {
        return error?.code === 'ENOENT' ? { value: undefined } : { unreadable: true };
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_PAUSE_MS);
    }
  }
}

/** Предел для журнала: минуты, а короче минуты (тесты) — секунды. */
function capLabel(ms) {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} мин` : `${Math.round(ms / 1000)} с`;
}

/** Идёт ли ход по журналу процессов; нечитаемый журнал — занято. */
export function ledgerBusy(file, isAlive, read = readFileSync) {
  const result = readJsonSteady(file, read);
  if (result.unreadable) return true;
  return busyRun(Array.isArray(result.value) ? result.value : [], isAlive);
}

/** Готовится ли копия группы; нечитаемое состояние — занято. */
function setupBusy(file, now) {
  const result = readJsonSteady(file);
  return result.unreadable === true || splitSetupRunning(result.value, now);
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
  const appData = appDataDirOf(configRoot);
  const runLedgers = RUN_LEDGERS.map((name) => join(appData, name));
  // Автотесты, агентский прогон тестов и проверка поломкой — свои журналы
  // процессов (Ф11): перезапуск посреди них рвал прогон и оставлял копию.
  const checkLedgers = CHECK_LEDGERS.map((name) => join(appData, name));
  const stateFile = join(appData, 'state.json');
  const repoRoot = resolve(serverDir, '..', '..');
  // Прошлый сторож мог оставить и состояние, и запрос: новый начинает с чистого.
  clearRestartState(appData);
  takeRestartRequest(appData);
  const defer = process.env.AGENTDECK_DEV_DEFER !== '0';
  const log = (line) => {
    console.log(`[dev-watch] ${line}`);
    appendDevLog(appData, line);
  };
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
      // Сервер читает состояние отсрочки там же, где его пишет сторож: его
      // собственный каталог данных может переехать настройкой.
      env: { ...process.env, AGENTDECK_DEV_RESTART_DIR: appData },
    });
    appendDevLog(appData, `сервер запущен (pid ${child.pid}, сторож ${process.pid})`);
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
    // Человек нажал «перезапустить сейчас» — ходы оборвутся, это его решение.
    // Запрос в счёт только посреди отсрочки: оставшийся от прошлой (сторож
    // успел перезапустить сам) иначе сорвал бы следующую, и живые ходы
    // оборвались бы без клика (ревью 30.09).
    const forced = takeRestartRequest(appData) && deferredSince !== undefined;
    // Живые ходы, подготовку копий и проверки ждём без предела; предел — только
    // у нечитаемого журнала ходов без доказанного живого хода (`runsWait`).
    const turns = runsWait(
      runLedgers.map((file) => readJsonSteady(file)),
      pidAlive,
      deferredSince,
      now,
      RUNS_CAP_MS,
    );
    const { capped, runs } = turns;
    const waitingFor =
      defer && !forced
        ? deferReason(
            turns.wait,
            setupBusy(stateFile, now),
            checkLedgers.some((file) => ledgerBusy(file, pidAlive)),
          )
        : undefined;
    if (waitingFor) {
      if (deferredSince === undefined) {
        deferredSince = now;
        log(
          RUNS_CAP_MS > 0
            ? `правки ждут конца идущих ходов, подготовки копий и проверок (без предела; нечитаемый журнал ходов — до ${capLabel(RUNS_CAP_MS)}) — перезапуск отложен`
            : 'правки ждут конца идущих ходов, подготовки копий и проверок — перезапуск без предела отложен',
        );
      }
      const capAt = turns.wait ? turns.capAt : undefined;
      writeRestartState(appData, {
        pid: process.pid,
        since: new Date(deferredSince).toISOString(),
        files: [...pending].map((file) => relative(repoRoot, file).replace(/\\/g, '/')),
        waitingFor,
        ...(capAt ? { capAt } : {}),
        ...(runs.length > 0 ? { runs } : {}),
      });
      timer = setTimeout(restart, DEFER_POLL_MS);
      return;
    }
    if (forced && deferredSince !== undefined) log('перезапуск по просьбе из панели');
    else if (defer && capped) {
      log(
        `предел ожидания нечитаемого журнала ходов (${capLabel(RUNS_CAP_MS)}): живых ходов в нём не видно — перезапуск`,
      );
    }
    deferredSince = undefined;
    clearRestartState(appData);
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

  const sources = new SourceWatcher(roots, (files) => {
    for (const file of files) pending.add(file);
    if (deferredSince === undefined) void restart();
  }).start();
  // Просьба о перезапуске, пока пачка ждёт тишины, закрывает её сразу; посреди отсрочки просьбу забирает
  // ожидание ходов (`restart`), как прежде. Просьба без ждущих правок снимается: оставшись в файле, она
  // закрыла бы следующую пачку на первом же сохранении.
  setInterval(() => {
    if (deferredSince !== undefined || probing || !takeRestartRequest(appData)) return;
    if (sources.waiting()) {
      log('перезапуск по просьбе, не дожидаясь тишины');
      sources.flushNow();
    } else {
      log('просьба о перезапуске снята: ждущих правок нет');
    }
  }, REQUEST_POLL_MS);
  launch();
  const stop = () => {
    const current = child;
    child = undefined;
    clearTimeout(relaunchTimer);
    clearRestartState(appData);
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
