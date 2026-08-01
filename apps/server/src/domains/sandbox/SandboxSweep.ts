import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { removeTree, sandboxRoot } from './SandboxPaths.ts';
import { isSandboxBusy, markExpired } from './SandboxRegistry.ts';
import type { SweepFailure, SweepReport, SweepReporter } from './SandboxConfig.types.ts';

/**
 * Пауза, на которую подметание щадит свежие папки: два сервера, стартующие
 * почти одновременно, не должны сносить песочницы друг друга.
 */
const SWEEP_GRACE_MS = 60_000;

/** Как часто работающий сервер подметает песочницы. */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/** Сколько песочница может простоять без единой записи, прежде чем считается брошенной. */
const SANDBOX_IDLE_MS = 2 * 60 * 60_000;

/**
 * Предел обхода при поиске свежести: песочница мелкая, но копия скилла тянет за
 * собой references/ и шаблоны. Упёрлись в предел — считаем найденное достаточным.
 */
const MTIME_SCAN_LIMIT = 2000;

let sweepTimer: ReturnType<typeof setInterval> | undefined;
let deferredTimer: ReturnType<typeof setTimeout> | undefined;

const stderrReporter: SweepReporter = (line) => {
  process.stderr.write(`${line}\n`);
};

function reportFailures(failed: SweepFailure[], report: SweepReporter): void {
  for (const item of failed) {
    report(
      `Песочницу не удалось убрать: ${item.path} — ${item.error}. В ней осталась копия доступа к аккаунту, удалите папку вручную.`,
    );
  }
}

/** Итог одного удаления в проходе подметания: успех — в список, отказ — в жалобу. */
function collect(dir: string, name: string, into: SweepReport): void {
  const wiped = removeTree(dir);

  if (wiped.ok) {
    into.removed.push(name);
    markExpired(name);
    return;
  }

  into.failed.push({ id: name, path: dir, error: wiped.error });
}

/**
 * Периодическое подметание брошенных песочниц — то, чего не хватало.
 *
 * Удаление жило ровно в двух местах: DELETE из размонтирования модалки и
 * подметание при СТАРТЕ сервера. Закрытая вкладка, перезагрузка страницы или
 * падение браузера никакого DELETE не шлют, а локальный сервер работает сутками —
 * и копия `.credentials.json` лежала на диске всё это время, хотя интерфейс
 * обещает «всё созданное стирается при закрытии окна». Каждое открытие модалки
 * заводит новый id, так что копии ещё и накапливались.
 *
 * Отличить открытую вкладку от закрытой сервер не может (реестр песочниц живёт в
 * памяти и о браузере ничего не знает), поэтому признак один — время. Берём самую
 * свежую отметку файла ВНУТРИ песочницы: любой прогон пишет и в config/ (там
 * переписка), и в work/. Запас намеренно большой: два часа тишины живой разговор
 * не выдержит, а секрет столько лежать не должен.
 */
export function startSandboxSweeper(
  options: { intervalMs?: number; idleMs?: number; root?: string; report?: SweepReporter } = {},
): () => void {
  stopSandboxSweeper();

  const idleMs = options.idleMs ?? SANDBOX_IDLE_MS;
  const root = options.root ?? sandboxRoot();
  const report = options.report ?? stderrReporter;

  const timer = setInterval(() => {
    // Ошибка подметания не должна ронять сервер: следующий тик попробует снова.
    // Но и промолчать нельзя — иначе копия доступа лежит на диске без следа.
    try {
      reportFailures(sweepIdleSandboxes(Date.now(), root, idleMs).failed, report);
    } catch (error) {
      report(
        `Подметание песочниц не выполнено: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, options.intervalMs ?? SWEEP_INTERVAL_MS);

  // Таймер не держит процесс живым: подметание — фон, а не работа сервера.
  timer.unref?.();
  sweepTimer = timer;

  return stopSandboxSweeper;
}

export function stopSandboxSweeper(): void {
  if (deferredTimer) {
    clearTimeout(deferredTimer);
    deferredTimer = undefined;
  }

  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}

/** Взвести подметание один раз — повторные вызовы ничего не меняют. */
export function armSandboxSweeper(): void {
  if (!sweepTimer) startSandboxSweeper();
}

/**
 * Один проход подметания по простою. В отличие от стартового, время считается по
 * самому свежему файлу внутри: на старте всё лежащее на диске брошено по
 * определению, а у работающего сервера часть песочниц открыта прямо сейчас.
 */
export function sweepIdleSandboxes(
  now: number = Date.now(),
  root: string = sandboxRoot(),
  idleMs: number = SANDBOX_IDLE_MS,
): SweepReport {
  const report: SweepReport = { removed: [], failed: [] };
  if (!existsSync(root)) return report;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    // Живой прогон важнее отметок времени: длинный агентный ход может часами
    // ничего не писать, и по одному mtime песочницу снесло бы из-под него.
    if (isSandboxBusy(entry.name)) continue;

    const dir = join(root, entry.name);
    if (now - newestMtime(dir, { left: MTIME_SCAN_LIMIT }) < idleMs) continue;

    collect(dir, entry.name, report);
  }

  return report;
}

/** Отметка времени пути; недоступный путь считаем свежим — трогать его не наше дело. */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** Самая свежая отметка внутри дерева: mtime самой папки не меняется от записи вглубь. */
function newestMtime(dir: string, budget: { left: number }): number {
  let newest = mtimeOf(dir);
  if (budget.left <= 0) return newest;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }

  for (const entry of entries) {
    if (budget.left-- <= 0) break;

    const child = join(dir, entry.name);
    const stamp = entry.isDirectory() ? newestMtime(child, budget) : mtimeOf(child);
    if (stamp > newest) newest = stamp;
  }

  return newest;
}

/**
 * Подметание при старте. Реестр песочниц живёт только в памяти сервера,
 * поэтому всё, что осталось на диске к моменту запуска, — след аварийного
 * завершения. Внутри такой папки лежит копия `.credentials.json` и значения
 * `env` MCP-серверов открытым текстом, и ждать, пока человек удалит её руками,
 * неправильно.
 */
export function sweepAbandonedSandboxes(
  now: number = Date.now(),
  root: string = sandboxRoot(),
): SweepReport & { deferred: string[] } {
  const report: SweepReport & { deferred: string[] } = { removed: [], failed: [], deferred: [] };
  if (!existsSync(root)) return report;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const dir = join(root, entry.name);

    // Пощажённые паузой не забываются: их доберёт отложенный проход, иначе
    // песочница, созданная за минуту до перезапуска панели, пережила бы старт и
    // осталась бы с копией доступа внутри до следующего перезапуска.
    if (now - statSync(dir).mtimeMs < SWEEP_GRACE_MS) {
      report.deferred.push(entry.name);
      continue;
    }

    // Только подтверждённое удаление: раньше сюда попадали и папки, которые
    // rmSync «удалил» лишь на словах, и лог старта врал про очистку.
    collect(dir, entry.name, report);
  }

  return report;
}

/**
 * Второй проход по тем, кого на старте пощадила пауза.
 *
 * Пауза защищает от гонки двух серверов, стартующих одновременно, — но не
 * должна дарить брошенной песочнице жизнь до следующего перезапуска. Условие
 * удаления жёсткое: внутри папки НИЧЕГО не менялось с момента запуска сервера.
 * Так отсеиваются и песочницы соседнего сервера (он в них пишет), и созданные
 * этим сервером уже после старта — у тех отметки заведомо новее.
 */
export function sweepDeferredSandboxes(
  names: string[],
  startedAt: number,
  root: string = sandboxRoot(),
): SweepReport {
  const report: SweepReport = { removed: [], failed: [] };

  for (const name of names) {
    if (isSandboxBusy(name)) continue;

    const dir = join(root, name);
    if (!existsSync(dir)) continue;
    if (newestMtime(dir, { left: MTIME_SCAN_LIMIT }) > startedAt) continue;

    collect(dir, name, report);
  }

  return report;
}

/**
 * Уборка песочниц на старте сервера — всё вместе и в одном месте.
 *
 * Три вещи, каждая из которых по отдельности дырява: разовый проход по диску
 * (следы аварийного завершения), взведённое подметание по простою (без него
 * таймер заводился только из createSandbox — то есть в процессе, где модалку
 * песочницы ни разу не открыли, его не было вовсе) и отложенный проход по
 * пощажённым паузой.
 */
export function startSandboxHousekeeping(
  options: {
    root?: string;
    now?: number;
    graceMs?: number;
    intervalMs?: number;
    idleMs?: number;
    report?: SweepReporter;
  } = {},
): SweepReport & { deferred: string[]; stop: () => void } {
  const root = options.root ?? sandboxRoot();
  const startedAt = options.now ?? Date.now();
  const report = options.report ?? stderrReporter;

  const first = sweepAbandonedSandboxes(startedAt, root);
  reportFailures(first.failed, report);

  startSandboxSweeper({
    intervalMs: options.intervalMs,
    idleMs: options.idleMs,
    root,
    report,
  });

  if (first.deferred.length > 0) {
    const timer = setTimeout(() => {
      deferredTimer = undefined;
      try {
        reportFailures(sweepDeferredSandboxes(first.deferred, startedAt, root).failed, report);
      } catch (error) {
        report(
          `Отложенная уборка песочниц не выполнена: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }, options.graceMs ?? SWEEP_GRACE_MS);

    // Как и подметание, отложенный проход процесс не держит.
    timer.unref?.();
    deferredTimer = timer;
  }

  return { ...first, stop: stopSandboxSweeper };
}
