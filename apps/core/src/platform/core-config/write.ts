import type { CoreConfig } from '@agentdeck/contracts/core/config';
import type { CoreHomeLayout } from '../core-home.ts';
import { writeFileAtomic, type AtomicWriteOptions } from '../safe-io/atomic-write.ts';
import { readBytesSync } from '../safe-io/files.ts';
import { configFilesOf, NO_CONFIG_DIGEST, sha256Hex, type ConfigFiles } from './files.ts';
import {
  CONFIG_CMDS_MAX,
  readConfigState,
  type ConfigCmd,
  type ConfigState,
  type ConfigWarning,
} from './state.ts';

/**
 * ЕДИНСТВЕННЫЙ писатель `config.json` (00:58): зовёт его только порт `POST /v1/config` после
 * суда `human-strict`. Порядок записи держит восстановление после краха:
 *   1. `config.state.json {pending}` — отпечаток того, что сейчас ляжет в файл;
 *   2. `config.json` атомарной заменой (повтор переименования: Windows отдаёт EPERM, пока файл
 *      держит читатель очереди или сканер);
 *   3. `config.last.json` — та же копия (действует, если файл потом поправят мимо API);
 *   4. `config.state.json {digest, cmds}` — запись завершена, ключ повтора запомнен.
 * Крах после 2 — файл несёт отпечаток `pending`: читатель видит восстановление, не дрейф.
 * Обратный порядок назвал бы собственную запись ядра правкой мимо API.
 *
 * Сверка `baseDigest` — с последней записью ЯДРА, а не с файлом: правка поверх чужой — отказ с
 * текущим отпечатком; файл, правленный мимо API, базой не бывает (его принимают, отправив его
 * документ от отпечатка последней записи — G6). Тот же `cmdId` — прежний исход без записи (P47).
 */

const MODE = 0o600;

export type ConfigWriteOutcome =
  | { kind: 'applied'; cmd: ConfigCmd }
  | { kind: 'replayed'; cmd: ConfigCmd }
  | { kind: 'stale'; digest: string };

export interface ConfigWriteMeta {
  by: string;
  warnings: ConfigWarning[];
  at: number;
}

export interface ConfigWriteOptions {
  rename?: AtomicWriteOptions['rename'];
  retry?: AtomicWriteOptions['retry'];
  /** Точки записи — только для тестов краха (исключение здесь = крах процесса). */
  step?: (done: 'pending' | 'config' | 'last') => void;
}

/** Текст документа, который пишет ядро: версия первой, перевод строки LF в конце. */
export function configText(doc: CoreConfig): string {
  const { v: _v, ...sections } = doc;
  return `${JSON.stringify({ v: 1, ...sections }, null, 2)}\n`;
}

function stateOrThrow(files: ConfigFiles): ConfigState | undefined {
  const state = readConfigState(files.state);
  if ('unknown' in state) throw new Error(`core config state unreadable: ${state.unknown}`);
  return 'value' in state ? state.value : undefined;
}

function writeState(files: ConfigFiles, state: ConfigState, opts: ConfigWriteOptions): void {
  writeFileAtomic(files.state, `${JSON.stringify(state)}\n`, { mode: MODE, ...atomic(opts) });
}

function atomic(opts: ConfigWriteOptions): AtomicWriteOptions {
  return {
    ...(opts.rename ? { rename: opts.rename } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
  };
}

function fileDigestOf(files: ConfigFiles): string | undefined {
  const bytes = readBytesSync(files.config);
  if ('absent' in bytes) return undefined;
  if ('unknown' in bytes) throw new Error(`core config unreadable: ${bytes.unknown}`);
  return sha256Hex(bytes.value);
}

/**
 * Запись в полёте после краха: файл несёт её отпечаток — запись состоялась, дописываются копия и
 * память; не несёт — файл не тронут, запись забывается (человек повторит тем же `cmdId`).
 */
export function recoverPending(
  where: Pick<CoreHomeLayout, 'config'>,
  opts: ConfigWriteOptions = {},
): { recovered: ConfigCmd } | { dropped: ConfigCmd } | undefined {
  const files = configFilesOf(where);
  const state = stateOrThrow(files);
  const pending = state?.pending;
  if (!state || !pending) return undefined;
  const { pending: _p, ...rest } = state;
  if (fileDigestOf(files) === pending.digest) {
    const bytes = readBytesSync(files.config);
    if (!('value' in bytes)) throw new Error('core config vanished during recovery');
    writeFileAtomic(files.last, bytes.value, { mode: MODE, ...atomic(opts) });
    writeState(
      files,
      { ...rest, digest: pending.digest, cmds: [...rest.cmds, pending].slice(-CONFIG_CMDS_MAX) },
      opts,
    );
    return { recovered: pending };
  }
  writeState(files, rest, opts);
  return { dropped: pending };
}

/**
 * Файл до этапа 7 (памяти писателя нет, файл есть) принимается один раз при загрузке: его байты
 * становятся последней записью ядра. Дальше любая правка мимо API — дрейф.
 */
export function adoptCoreConfig(
  where: Pick<CoreHomeLayout, 'config'>,
  at: number,
  opts: ConfigWriteOptions = {},
): { digest: string } | undefined {
  const files = configFilesOf(where);
  if (stateOrThrow(files)) return undefined;
  const bytes = readBytesSync(files.config);
  if ('absent' in bytes) return undefined;
  if ('unknown' in bytes) throw new Error(`core config unreadable: ${bytes.unknown}`);
  const digest = sha256Hex(bytes.value);
  writeFileAtomic(files.last, bytes.value, { mode: MODE, ...atomic(opts) });
  writeState(files, { v: 1, digest, adoptedAt: at, cmds: [] }, opts);
  return { digest };
}

/** Отпечаток, от которого правит человек: последняя запись ядра, до неё — файл или «нет». */
export function currentConfigDigest(where: Pick<CoreHomeLayout, 'config'>): string {
  const files = configFilesOf(where);
  const state = stateOrThrow(files);
  if (state) return state.digest;
  return fileDigestOf(files) ?? NO_CONFIG_DIGEST;
}

export function findConfigCmd(
  where: Pick<CoreHomeLayout, 'config'>,
  cmdId: string,
): ConfigCmd | undefined {
  return stateOrThrow(configFilesOf(where))?.cmds.find((c) => c.cmdId === cmdId);
}

export function writeCoreConfig(
  where: Pick<CoreHomeLayout, 'config'>,
  doc: CoreConfig,
  baseDigest: string,
  cmdId: string,
  meta: ConfigWriteMeta,
  opts: ConfigWriteOptions = {},
): ConfigWriteOutcome {
  const files = configFilesOf(where);
  // Крах прошлой записи дописывается до суда: иначе её ключ повтора и отпечаток потерялись бы.
  recoverPending(where, opts);
  const state = stateOrThrow(files);
  const seen = state?.cmds.find((c) => c.cmdId === cmdId);
  if (seen) return { kind: 'replayed', cmd: seen };
  const current = state?.digest ?? fileDigestOf(files) ?? NO_CONFIG_DIGEST;
  if (current !== baseDigest) return { kind: 'stale', digest: current };
  const text = configText(doc);
  const cmd: ConfigCmd = { cmdId, digest: sha256Hex(text), ...meta };
  // Памяти ещё нет: файл до этапа 7 сначала принимается (его копия — последняя запись ядра),
  // иначе крах этой записи оставил бы память без копии, и правка мимо API читалась бы `unknown`.
  if (!state) adoptCoreConfig(where, meta.at, opts);
  const before: ConfigState = stateOrThrow(files) ?? { v: 1, digest: current, cmds: [] };
  writeState(files, { ...before, pending: cmd }, opts);
  opts.step?.('pending');
  writeFileAtomic(files.config, text, { mode: MODE, ...atomic(opts) });
  opts.step?.('config');
  writeFileAtomic(files.last, text, { mode: MODE, ...atomic(opts) });
  opts.step?.('last');
  const { pending: _p, ...rest } = before;
  writeState(
    files,
    { ...rest, digest: cmd.digest, cmds: [...rest.cmds, cmd].slice(-CONFIG_CMDS_MAX) },
    opts,
  );
  return { kind: 'applied', cmd };
}
