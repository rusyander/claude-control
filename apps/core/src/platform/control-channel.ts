import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentOs, type OsKind } from './os-kind.ts';

/**
 * Канал управления хостом сессии (01 §Sessions at core death): именованный канал Windows
 * или unix-сокет. Имя канала видно любому процессу машины — доступ даёт только ключ из
 * файла (сам ключ здесь не живёт).
 *
 * POSIX: путь сокета ограничен `sun_path` — 104 байта на macOS, 108 на Linux; дом ядра в
 * глубоком профиле его превышает, и `listen` падает с EINVAL далеко от причины. Поэтому
 * сокет живёт в личном каталоге 0700, который подбирает `privateChannelDir` (session-host)
 * под этот предел. Не уложился — отказ с причиной (F-60): прежний запасной путь
 * `/tmp/ad-sh-<id>.sock` лежал в общем каталоге с предсказуемым именем, и чужой пользователь
 * мог занять его заранее.
 */

const SUN_PATH_MAX = 100;

export function channelPath(id: string, os: OsKind = currentOs(), dir: string = tmpdir()): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (os === 'win32') return `\\\\.\\pipe\\agentdeck-sh-${safe}`;
  const socket = path.posix.join(dir, `ad-sh-${safe}.sock`);
  if (Buffer.byteLength(socket) > SUN_PATH_MAX)
    throw new Error(`control socket path exceeds sun_path (${SUN_PATH_MAX} bytes): ${socket}`);
  return socket;
}

/** Убрать файл сокета (прежний хост с тем же id, выход хоста); канал Windows — не файл. */
export function removeChannel(channel: string, os: OsKind = currentOs()): void {
  if (os === 'win32') return;
  rmSync(channel, { force: true });
}
