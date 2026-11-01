import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CoreEntryCheckDeps, CoreLiveness, ListenRow } from '@agentdeck/contracts/core/procs';
import { readProcessTableAsync } from '../kill-tree.mjs';
import { execText, type Exec } from '../peer-process/peer-process.ts';

/**
 * Факты ОС для проверки личности ядра перед отправкой ему bearer (core-s9 F10, F-19): кто
 * СЛУШАЕТ порт строки `procs.json` и жив ли процесс строки с тем же стартом. Сама проверка —
 * `verifyCoreEntry` контрактов, одна у ядра и у панели; здесь только чтения ОС панели (кода
 * ядра панель не импортирует — граница depcruise).
 *
 * Таблица соединений `peer-process` строки LISTEN отбрасывает (у них нет порта той стороны),
 * поэтому слушатели читаются своим разбором: Windows `netstat -ano`, Linux `/proc/net/tcp{,6}`
 * (состояние 0A) с владельцем по inode, macOS `lsof -sTCP:LISTEN`.
 *
 * Старт процесса — тем же токеном, что пишет ядро (`platform/process-table.ts` ядра):
 * win32 — FILETIME создания; linux — `<boot_id[0..8]>:<starttime>`; darwin —
 * `<сек lstart>:<sha1(ucomm)[0..8]>`. Не совпал — `dead`: проверка закрыта, bearer не уходит.
 */

function portOf(endpoint: string): number | undefined {
  const match = /:(\d+)$/.exec(endpoint.trim());
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

function hostOf(endpoint: string): string {
  const at = endpoint.trim().lastIndexOf(':');
  return (at > 0 ? endpoint.trim().slice(0, at) : endpoint.trim()).replace(/^\[|\]$/g, '');
}

/**
 * `netstat -ano`: `TCP  127.0.0.1:5190  0.0.0.0:0  LISTENING  1234` (и `[::1]:5190`). Слушатель
 * узнаётся по порту той стороны `0`, а не по слову состояния: Windows переводит его на язык
 * системы (немецкая — `ABHÖREN`), а соединение с портом `0` на той стороне не бывает.
 */
export function parseNetstatListen(text: string): ListenRow[] {
  const rows: ListenRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !/^TCP/i.test(parts[0] ?? '')) continue;
    if (!/:0$/.test(parts[2] ?? '')) continue;
    const localPort = portOf(parts[1] ?? '');
    const pid = Number(parts[4]);
    if (localPort === undefined) continue;
    rows.push({
      state: 'listen',
      localAddress: hostOf(parts[1] ?? ''),
      localPort,
      ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    });
  }
  return rows;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: `p<pid>`, затем `n<адрес>:<порт>` (`*` — любой адрес). */
export function parseLsofListen(text: string): ListenRow[] {
  const rows: ListenRow[] = [];
  let pid: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || undefined;
    if (!line.startsWith('n') || line.includes('->')) continue;
    const endpoint = line.slice(1);
    const localPort = portOf(endpoint);
    if (localPort === undefined) continue;
    const host = hostOf(endpoint);
    rows.push({
      state: 'listen',
      localAddress: host === '*' ? '0.0.0.0' : host,
      localPort,
      ...(pid ? { pid } : {}),
    });
  }
  return rows;
}

/** Адрес `/proc/net/tcp*` в hex: слова по 32 бита, байты в слове — младшим вперёд. */
export function procNetAddress(hex: string): string {
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((w) => [6, 4, 2, 0].map((i) => parseInt(w.slice(i, i + 2), 16)));
  if (bytes.length === 4) return bytes.join('.');
  if (bytes.length !== 16 || bytes.some((b) => Number.isNaN(b))) return hex;
  if (bytes.every((b) => b === 0)) return '::';
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return '::1';
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff)
    return `::ffff:${bytes.slice(12).join('.')}`;
  return hex.toLowerCase();
}

/** Строки LISTEN (`st` = `0A`) таблицы `/proc/net/tcp*`: адрес, порт, inode сокета. */
export function parseProcNetListen(
  text: string,
): { localAddress: string; localPort: number; inode: string }[] {
  const rows: { localAddress: string; localPort: number; inode: string }[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10 || parts[3] !== '0A') continue;
    const [addr = '', port = ''] = (parts[1] ?? '').split(':');
    const localPort = parseInt(port, 16);
    const inode = parts[9] ?? '';
    if (!localPort || !inode || inode === '0') continue;
    rows.push({ localAddress: procNetAddress(addr), localPort, inode });
  }
  return rows;
}

function linuxListen(port: number, proc: string): ListenRow[] {
  const sockets = ['tcp', 'tcp6'].flatMap((name) => {
    try {
      return parseProcNetListen(readFileSync(`${proc}/net/${name}`, 'utf8'));
    } catch {
      return []; // нет таблицы (без IPv6) — смотрим вторую
    }
  });
  const needed = sockets.filter((row) => row.localPort === port);
  const owner = new Map<string, number>();
  if (needed.length > 0) {
    const inodes = new Set(needed.map((row) => `socket:[${row.inode}]`));
    for (const entry of readdirSync(proc)) {
      if (!/^\d+$/.test(entry)) continue;
      let fds: string[];
      try {
        fds = readdirSync(`${proc}/${entry}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        try {
          const target = readlinkSync(`${proc}/${entry}/fd/${fd}`);
          if (inodes.has(target)) owner.set(target.slice(8, -1), Number(entry));
        } catch {
          // процесс ушёл между чтениями
        }
      }
    }
  }
  return needed.map((row) => {
    const pid = owner.get(row.inode);
    return {
      state: 'listen' as const,
      localAddress: row.localAddress,
      localPort: row.localPort,
      ...(pid ? { pid } : {}),
    };
  });
}

/** Слушатели порта `port` с владельцами; ОС не ответила — `unknown` с причиной. */
export async function readListenTable(
  port: number,
  platform: string = process.platform,
  exec: Exec = execText,
  proc = '/proc',
): Promise<Fact<ListenRow[]>> {
  if (platform === 'win32') {
    const text = await exec('netstat', ['-ano']);
    return text === undefined
      ? { unknown: 'netstat did not answer' }
      : { value: parseNetstatListen(text) };
  }
  if (platform === 'darwin') {
    const text = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']);
    // lsof без совпадений выходит с кодом 1 — пустая таблица, а не сбой ОС.
    return { value: text === undefined ? [] : parseLsofListen(text) };
  }
  try {
    return { value: linuxListen(port, proc) };
  } catch (error) {
    return { unknown: `/proc/net: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Поля `/proc/<pid>/stat` считаются после ПОСЛЕДНЕЙ `)` (имя процесса может содержать `)`):
 * starttime — поле 22, т.е. 20-е после имени.
 */
export function linuxStartOf(stat: string, bootId: string): string | undefined {
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const starttime = rest[19];
  return starttime && /^\d+$/.test(starttime) ? `${bootId}:${starttime}` : undefined;
}

/** `ps -o lstart= -o ucomm=` под `LC_ALL=C` → токен старта darwin, как у ядра. */
export function darwinStartOf(line: string): string | undefined {
  const match = /^\s*(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/.exec(line);
  if (!match) return undefined;
  const ms = Date.parse((match[1] ?? '').replace(/\s+/g, ' '));
  if (!Number.isFinite(ms)) return undefined;
  const name = createHash('sha1')
    .update((match[2] ?? '').trim())
    .digest('hex')
    .slice(0, 8);
  return `${Math.floor(ms / 1000)}:${name}`;
}

/**
 * Совпадает ли старт с записанным. Windows: снимок CIM (запасной путь и у ядра, и у панели)
 * отдаёт время создания с точностью до микросекунды, а помощник — до 100 нс; один и тот же
 * процесс поэтому может разойтись в последнем разряде. Номер, занятый другим процессом в ту же
 * микросекунду, невозможен, — допуск 1 мкс (10 тиков) личности не ослабляет.
 */
export function sameStart(platform: string, recorded: string, observed: string): boolean {
  if (recorded === observed) return true;
  if (platform !== 'win32' || !/^\d+$/.test(recorded) || !/^\d+$/.test(observed)) return false;
  const diff = BigInt(recorded) - BigInt(observed);
  return (diff < 0n ? -diff : diff) < 10n;
}

/** Токен старта процесса `pid`; `null` — процесса нет; `undefined` — ОС не ответила. */
export async function processStartOf(
  pid: number,
  platform: string = process.platform,
  exec: Exec = execText,
  proc = '/proc',
): Promise<string | null | undefined> {
  if (platform === 'win32') {
    const table = await readProcessTableAsync('win32');
    if (!table) return undefined;
    const row = table.find((r) => r.pid === pid);
    return row ? (row.created > 0n ? String(row.created) : undefined) : null;
  }
  if (platform === 'darwin') {
    const text = await exec('ps', ['-o', 'lstart=', '-o', 'ucomm=', '-p', String(pid)]);
    // `ps -p` без такого процесса выходит с кодом 1 — для нас это «нет процесса».
    if (text === undefined || text.trim() === '') return null;
    return darwinStartOf(text.split(/\r?\n/)[0] ?? '') ?? undefined;
  }
  let stat: string;
  try {
    stat = readFileSync(`${proc}/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  let bootId = 'boot';
  try {
    bootId = readFileSync(`${proc}/sys/kernel/random/boot_id`, 'utf8').trim().slice(0, 8) || bootId;
  } catch {
    // без boot_id (урезанный /proc контейнера) — так же, как пишет ядро
  }
  return linuxStartOf(stat, bootId);
}

export interface IdentityOptions {
  platform?: string;
  exec?: Exec;
  /** Положительная живость (pid + старт) помнится столько мс: снимок процессов Windows дорог. */
  aliveTtlMs?: number;
  now?: () => number;
}

/**
 * Зависимости `verifyCoreEntry` у панели. Слушатель порта читается на КАЖДОМ запросе (ядро могло
 * смениться на том же порту), живость с тем же стартом — из короткой памяти: номер с другим
 * стартом в ней не найдётся, а «жив» уже проверенного процесса за минуту не устаревает опаснее,
 * чем сам слушатель, который проверяется заново.
 */
export interface CoreIdentityDeps extends CoreEntryCheckDeps {
  /**
   * Есть ли процесс с этим номером вообще (без памяти, свежим чтением): сверка не прошла, и
   * прокладке надо сказать человеку, ядро не запущено (процесса строки нет) или строка не
   * подтвердилась (процесс есть, но порт слушает другой). `undefined` — ОС не ответила.
   */
  exists(pid: number): Promise<boolean | undefined>;
}

export function createCoreIdentityDeps(
  options: IdentityOptions = {},
): (port: number) => CoreIdentityDeps {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? execText;
  const ttl = options.aliveTtlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const alive = new Map<string, number>();
  const isAlive = async (id: { pid: number; start: string }): Promise<CoreLiveness> => {
    const key = `${id.pid}|${id.start}`;
    const seen = alive.get(key);
    if (seen !== undefined && now() - seen < ttl) return 'alive';
    const start = await processStartOf(id.pid, platform, exec);
    if (start === undefined) return 'unknown';
    if (start === null || !sameStart(platform, id.start, start)) {
      alive.delete(key);
      return 'dead';
    }
    alive.set(key, now());
    return 'alive';
  };
  const exists = async (pid: number) => {
    const start = await processStartOf(pid, platform, exec);
    return start === undefined ? undefined : start !== null;
  };
  return (port) => ({ tcp: () => readListenTable(port, platform, exec), isAlive, exists });
}
