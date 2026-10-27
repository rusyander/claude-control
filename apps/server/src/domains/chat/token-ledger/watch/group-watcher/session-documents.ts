import { fileDocumentSource, type ForeignDocumentReader } from '../../foreign/foreign-document.ts';
import type { ForeignDocumentSource } from '../../foreign/foreign.types.ts';
import type { WatchEvent } from '../watch.types.ts';

/**
 * Переписка-документ чужого CLI (Continue — файл, OpenCode — запись базы): документ
 * переписывается целиком, отступа хвоста у него нет. Документ перечитывается,
 * только когда сдвинулся его отпечаток (время и размер файла или базы), и не чаще
 * раза в `minIntervalMs`; что уже отдано сторожу, помнит читатель (ключи записей),
 * а не отступ.
 */

interface DocStamp {
  mtimeMs: number;
  size: number;
  readAt: number;
}

/** Сколько документов помнить: у Continue каждый ход — свой файл. */
const STAMP_CAP = 200;

export class SessionDocuments {
  private readonly stamps = new Map<string, DocStamp>();

  /** Новые события документа; не сдвинулся, рано или недописан — пусто. */
  read(
    ref: string,
    reader: ForeignDocumentReader,
    now: number,
    minIntervalMs = 30_000,
    source: ForeignDocumentSource = fileDocumentSource,
  ): WatchEvent[] {
    const known = this.stamps.get(ref);
    if (known && now - known.readAt < minIntervalMs) return [];
    const stat = source.stamp(ref);
    if (!stat) return [];
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
      known.readAt = now;
      return [];
    }
    const doc = source.load(ref);
    // Недописанный документ: отметку не ставим — на следующем тике он прочтётся снова.
    if (doc === undefined) return [];
    this.remember(ref, { ...stat, readAt: now });
    return reader(doc, now);
  }

  /**
   * Прошлое документа — в отданное без событий (подхват после перезапуска панели:
   * прошлое не догоняется). Документ, родившийся в этом ходе (`bornSince`), — с начала.
   */
  prime(
    ref: string,
    reader: ForeignDocumentReader,
    now: number,
    bornSince?: number,
    source: ForeignDocumentSource = fileDocumentSource,
  ): void {
    if (this.stamps.has(ref)) return;
    const stat = source.stamp(ref);
    if (!stat) return;
    const born = bornSince !== undefined ? source.bornAt(ref) : undefined;
    if (bornSince !== undefined && born !== undefined && born >= bornSince) return;
    const doc = source.load(ref);
    if (doc === undefined) return;
    reader(doc, now);
    this.remember(ref, { mtimeMs: stat.mtimeMs, size: stat.size, readAt: 0 });
  }

  forget(ref: string): void {
    this.stamps.delete(ref);
  }

  private remember(ref: string, stamp: DocStamp): void {
    this.stamps.delete(ref);
    this.stamps.set(ref, stamp);
    if (this.stamps.size > STAMP_CAP) this.stamps.delete(this.stamps.keys().next().value as string);
  }
}
