import { accessSync, constants, existsSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  TransferFileRecord,
  TransferRecord,
  TransferRevertAnswer,
} from '@agentdeck/contracts/portable-transfer';
import {
  backupEntry,
  removeEntry,
  transferBackupName,
  writeBinaryFile,
} from '../../lib/safe-io.ts';
import { coded } from '../../lib/server-text.ts';
import type { EmitWrite } from './emit/types.ts';

/**
 * Применение переноса и его ОТМЕНА — один модуль, потому что это одна сделка
 * (П2.3).
 *
 * Перенос трогает десятки чужих файлов сразу, и половина перенесённой среды
 * хуже нетронутой: человек не знает, где она оборвалась, а CLI уже читает смесь
 * своего и нашего. Отсюда три правила, которые здесь исполняются, а не
 * обещаются:
 *
 *  1. **Копия — первой.** Каждый файл копируется ДО своей записи, и если
 *     копировать некуда (копии выключены в настройках), перенос не начинается
 *     вовсе: без копий отмены не существует, а обещать её и не иметь — хуже,
 *     чем отказать.
 *  2. **Провал на середине откатывает ВСЁ применённое**, а не бросает как есть.
 *     Возврат идёт в обратном порядке и по тем же копиям, которыми пользуется
 *     кнопка отмены, — второго механизма отката в коде нет, иначе один из двух
 *     оставался бы непроверенным ровно до того дня, когда понадобится.
 *  3. **Отмена существует и без провала.** Пока нельзя вернуть всё назад одной
 *     кнопкой, первую кнопку человек не нажмёт: цена ошибки для него неизвестна.
 */

/** Копии выключены в настройках — перенос без них не начинается. */
export class TransferBackupsDisabledError extends Error {
  constructor() {
    super('Перенос не начат: резервные копии выключены, а без них отменить его будет нечем.');
    this.name = 'TransferBackupsDisabledError';
  }
}

/** Файл цели занят, только для чтения, или каталог недоступен на запись. */
export class TransferTargetNotWritableError extends Error {
  readonly filePath: string;

  constructor(filePath: string) {
    super(`Перенос не начат: файл цели «${filePath}» недоступен для записи.`);
    this.name = 'TransferTargetNotWritableError';
    this.filePath = filePath;
  }
}

/**
 * Запись провалилась, и всё применённое возвращено к состоянию «до».
 *
 * `rolledBack: false` означает, что не удался и сам откат: это худший из
 * исходов, и он обязан быть отличим от обычного провала — человеку нужно знать,
 * что на диске осталась смесь, и где лежат копии.
 */
export class TransferRolledBackError extends Error {
  readonly filePath: string;
  readonly rolledBack: boolean;

  constructor(filePath: string, rolledBack: boolean, cause: unknown) {
    super(
      rolledBack
        ? `Запись файла «${filePath}» не удалась — перенос отменён целиком, файлы вернулись к состоянию до него.`
        : `Запись файла «${filePath}» не удалась, и откат тоже: часть файлов осталась изменённой, копии лежат в каталоге резервных копий.`,
      { cause },
    );
    this.name = 'TransferRolledBackError';
    this.filePath = filePath;
    this.rolledBack = rolledBack;
  }
}

/**
 * Применить план.
 *
 * `backupDir` обязателен по правилу 1, и это единственный способ выключить
 * перенос настройкой: свой аргумент «без копий» здесь не заводится.
 */
export function applyTransfer(
  targetId: string,
  root: string,
  writes: readonly EmitWrite[],
  backupDir: string | undefined,
): TransferFileRecord[] {
  if (!backupDir) throw coded(new TransferBackupsDisabledError(), 'portability-backups-off');

  // Проверка доступности — ДО первой копии и первой записи: «диск полон, файл
  // занят» обязано останавливать перенос целиком, а не на середине. Проверка
  // не гарантия (файл может стать недоступен строкой позже) — гарантия это
  // откат ниже; она убирает самый частый случай до того, как что-то тронуто.
  for (const write of writes) assertWritable(write.filePath);

  const done: TransferFileRecord[] = [];
  for (const [filePath, group] of groupByFile(writes)) {
    const createdDir = missingAncestor(filePath);
    let backupPath: string | undefined;
    try {
      // Копия — ОДНА на файл и до первого его слоя. Снятая перед вторым слоем,
      // она содержала бы уже наш первый, и отмена вернула бы файл к тому
      // состоянию, которого до переноса не существовало.
      backupPath = backupEntry(filePath, backupDir, transferBackupName(targetId, root, filePath));
      // Копия снята НАМИ и запомнена в следе; отдать `backupDir` адаптеру
      // значило бы снять вторую, под его собственным именем, и вытеснить из
      // ротации ту, к которой возвращается отмена.
      for (const write of group) write.apply(undefined);
      done.push({
        filePath,
        backupPath: backupPath ?? null,
        writtenHash: hashOf(filePath),
        createdDir,
      });
    } catch (error) {
      const failed: TransferFileRecord = {
        filePath,
        backupPath: backupPath ?? null,
        writtenHash: '',
        createdDir,
      };
      // Провалившийся файл возвращается первым: запись могла не начаться вовсе,
      // а могла и пройти наполовину в чужом адаптере.
      const rolledBack = rollback([...done, failed]);
      throw coded(
        new TransferRolledBackError(filePath, rolledBack, error),
        rolledBack ? 'portability-apply-rolled-back' : 'portability-apply-rollback-failed',
      );
    }
  }

  return done;
}

/**
 * Отменить перенос по его следу.
 *
 * Файл, который человек правил уже ПОСЛЕ переноса, не трогается: его правка
 * новее нашей записи, и «отменить перенос» не означает «стереть всё, что было
 * потом». Такие файлы возвращаются списком и ждут, пока он назовёт их сам —
 * `confirmed`.
 */
export function revertTransfer(
  record: TransferRecord,
  confirmed: readonly string[],
): TransferRevertAnswer {
  const restored: string[] = [];
  const changedSince: string[] = [];
  const left: TransferFileRecord[] = [];

  // В обратном порядке: файл и каталог, созданные последними, снимаются первыми,
  // иначе пустой каталог скилла остаётся лежать после удаления своего SKILL.md.
  for (const file of [...record.files].reverse()) {
    if (!sameAsWritten(file) && !confirmed.includes(file.filePath)) {
      changedSince.push(file.filePath);
      left.push(file);
      continue;
    }
    restoreFile(file);
    restored.push(file.filePath);
  }

  return {
    restored: restored.reverse(),
    changedSince: changedSince.reverse(),
    record: left.length === 0 ? null : { ...record, files: left.reverse() },
  };
}

/**
 * Файлы следа, которые человек правил уже ПОСЛЕ переноса, — без всякой записи.
 *
 * Тем же `sameAsWritten`, что и отмена, намеренно: две реализации «изменился ли
 * файл» разошлись бы на первом же краю (пропавший файл, другой перевод строки),
 * и экран предупреждал бы об одном наборе файлов, а отмена отказывалась трогать
 * другой.
 */
export function changedSinceTransfer(record: TransferRecord): string[] {
  return record.files.filter((file) => !sameAsWritten(file)).map((file) => file.filePath);
}

/**
 * Правки по файлам, в порядке появления, — след переноса хранит ФАЙЛЫ.
 *
 * Та же группировка, что в плане (`plan.ts`), и по той же причине: один файл
 * цели собирает несколько слоёв, а копия у него одна и запись в следе одна.
 */
function groupByFile(writes: readonly EmitWrite[]): Map<string, EmitWrite[]> {
  const groups = new Map<string, EmitWrite[]>();
  for (const write of writes) {
    const group = groups.get(write.filePath);
    if (group) group.push(write);
    else groups.set(write.filePath, [write]);
  }
  return groups;
}

/**
 * Вернуть применённое. Возвращает `false`, если хоть один файл вернуть не
 * удалось: молчать об этом нельзя — на диске осталась смесь.
 */
function rollback(files: readonly TransferFileRecord[]): boolean {
  let ok = true;
  for (const file of [...files].reverse()) {
    try {
      restoreFile(file);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/**
 * Один файл назад. Копии нет — значит, файла не было вовсе: он удаляется вместе
 * с каталогами, которые перенос под него создал, иначе «байт в байт как до»
 * оставляло бы после себя пустые папки.
 */
function restoreFile(file: TransferFileRecord): void {
  if (file.backupPath === null) {
    removeEntry(file.filePath);
    pruneCreatedDirs(file.filePath, file.createdDir);
    return;
  }
  // Побайтно и атомарно: копия могла быть снята с файла в любой форме (BOM,
  // CRLF), и возврат «по форме нынешнего файла» изменил бы её.
  writeBinaryFile(file.filePath, readFileSync(file.backupPath), {});
}

/** Правил ли человек этот файл после переноса. Исчезнувший файл — тоже правка. */
function sameAsWritten(file: TransferFileRecord): boolean {
  if (!existsSync(file.filePath)) return false;
  return hashOf(file.filePath) === file.writtenHash;
}

/**
 * Отпечаток файла на диске — `null`, если файла нет.
 *
 * Одно определение «каким панель этот файл оставила» на весь перенос: по нему
 * отмена отказывается трогать файл, правленный после записи, и по нему же
 * подписка держит пересборку (П5.2). Второе такое определение разошлось бы с
 * первым на форме файла — BOM, переводы строк, — то есть молча.
 */
export function fileHashOrNull(path: string): string | null {
  return existsSync(path) ? hashOf(path) : null;
}

function hashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Верхний из каталогов, которых ещё нет. Считается ДО записи: после неё они уже
 * созданы, и отличить свои от чужих будет нечем.
 */
function missingAncestor(filePath: string): string | null {
  let dir = dirname(filePath);
  let top: string | null = null;
  while (!existsSync(dir)) {
    top = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return top;
}

/**
 * Снять созданные переносом каталоги — но только пустые и только до отметки.
 *
 * Непустой каталог оставляем и выше не идём: в нём лежит чужое, и удалять его
 * ради чистоты значило бы унести с собой то, чего перенос не приносил.
 */
function pruneCreatedDirs(filePath: string, createdDir: string | null): void {
  if (!createdDir) return;
  for (let dir = dirname(filePath); ;) {
    if (existsSync(dir)) {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    }
    if (dir === createdDir) return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * Доступен ли путь на запись. У несуществующего файла спрашиваем ближайший
 * существующий каталог: создать файл в каталоге только для чтения нельзя, и
 * узнать об этом лучше до того, как переписан первый файл.
 */
function assertWritable(filePath: string): void {
  const probe = existsSync(filePath) ? filePath : nearestExisting(dirname(filePath));
  try {
    accessSync(probe, constants.W_OK);
  } catch {
    throw coded(new TransferTargetNotWritableError(filePath), 'portability-target-not-writable');
  }
}

function nearestExisting(dir: string): string {
  for (let current = dir; ;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}
