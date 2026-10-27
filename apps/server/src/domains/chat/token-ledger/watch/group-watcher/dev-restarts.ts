import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DEV_WATCH_LOG, readRestartState } from '../../../../../lib/dev-restart.mjs';
import { parseDevRestarts, type DevRestart, type RestartFeed } from './restart-rules.ts';

/**
 * Читатель перезапусков для R38/R39: хвост журнала dev-watch (и прежнего `.1`, если
 * нынешний моложе часа) и ждущий перезапуск из `dev-restart.json`. Журнал перечитывается
 * только при смене размера или времени записи — тик сторожа идёт часто.
 */

/** Хвост журнала: час перезапусков с запасом (строка ~200 байт, 362 перезапуска за сутки). */
const TAIL_BYTES = 128 * 1024;
const HOUR_MS = 60 * 60_000;

function tailOf(file: string): string {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // Начало хвоста режет строку посередине — её не судим.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function stamp(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

/**
 * `root` — корень обслуживаемого дерева: dev-watch пишет файлы ждущего перезапуска от него
 * (`apps/server/…`), а правки группы сторож держит полными путями — без корня R38 не сойдётся.
 */
export function createRestartFeed(
  appData: string,
  root: string,
  now: () => number = Date.now,
): () => RestartFeed {
  const log = join(appData, DEV_WATCH_LOG);
  let seen = '';
  let done: DevRestart[] = [];
  return () => {
    const key = stamp(log);
    if (key !== seen) {
      seen = key;
      done = parseDevRestarts(tailOf(log));
      // Журнал только что ушёл в `.1`: час перезапусков начинается там.
      const first = done[0]?.at;
      if (first === undefined || now() - first < HOUR_MS) {
        done = [...parseDevRestarts(tailOf(`${log}.1`)), ...done];
      }
    }
    const state = readRestartState(appData);
    const since = state.since ? Date.parse(state.since) : NaN;
    return {
      done,
      ...(state.pending && Number.isFinite(since) && state.files?.length
        ? {
            pending: {
              since,
              files: state.files.map((file) => (isAbsolute(file) ? file : join(root, file))),
            },
          }
        : {}),
    };
  };
}
