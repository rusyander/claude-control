import { join } from 'node:path';
import { z } from 'zod';
import { boardEntrySchema } from '@agentdeck/contracts/core/board';
import { uuidv7 } from '@agentdeck/contracts/core/ids';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import type { BoardFile, BoardStore, BoardStoreDeps } from './store.types.ts';

/**
 * Хранилище записей доски (этап 12, P181): `<дом ядра>/board.json` — НЕ журнал, а снимок записей
 * до задач (входящие, очередь, старт, отклонённые), их рангов и применённых ходов. Один писатель —
 * этот модуль; запись — атомарной заменой (временный файл + rename), так что читатель видит или
 * прежний файл, или новый, а крах посреди записи не оставляет половину. Применённые `cmdId`
 * хранятся рядом: повтор того же хода после краха отвечает «уже было», а не делает ход второй раз.
 * Нечитаемый файл — «неизвестно» (ошибка), а не пустая доска: иначе запись человека молча пропала бы.
 */

export const BOARD_FILE = 'board.json';
/** Сколько последних `cmdId` держать для повтора: старее — повтор уже никто не шлёт. */
export const BOARD_MOVES_KEPT = 1000;

const boardFileSchema = z.strictObject({
  v: z.literal(1),
  entries: z.array(boardEntrySchema),
  moves: z.array(
    z.strictObject({
      cmdId: uuidv7,
      at: z.number().int().nonnegative(),
      created: z.array(uuidv7).optional(),
    }),
  ),
});

export class BoardStoreError extends Error {}

export function boardFilePath(root: string): string {
  return join(root, BOARD_FILE);
}

/** Прочитать файл доски с диска: нет файла — пустая доска; нечитаемый или негодный — ошибка. */
export function readBoardFile(path: string): BoardFile {
  const fact = readBytesSync(path);
  if ('absent' in fact) return { v: 1, entries: [], moves: [] };
  if ('unknown' in fact) throw new BoardStoreError(`board store unreadable: ${fact.unknown}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fact.value.toString('utf8'));
  } catch (error) {
    throw new BoardStoreError(`board store is not JSON: ${(error as Error).message}`);
  }
  const parsed = boardFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new BoardStoreError(`board store failed its schema: ${parsed.error.message}`);
  return parsed.data;
}

export function createBoardStore(deps: BoardStoreDeps): BoardStore {
  const path = boardFilePath(deps.root);
  const write = deps.write ?? ((p: string, text: string) => writeFileAtomic(p, text));
  let cache: BoardFile | null = null;

  const load = (): BoardFile => {
    // Один писатель: после первого чтения правда — память, диск только догоняет её.
    cache ??= readBoardFile(path);
    return cache;
  };

  return {
    path,
    read: () => structuredClone(load()),
    applied(cmdId) {
      return load().moves.find((m) => m.cmdId === cmdId);
    },
    update(cmdId, at, change) {
      const current = load();
      const next = structuredClone(current);
      const outcome = change(next);
      if (!outcome.ok) return outcome;
      if (cmdId !== null) {
        next.moves.push({
          cmdId,
          at,
          ...(outcome.created ? { created: outcome.created } : {}),
        });
        if (next.moves.length > BOARD_MOVES_KEPT) next.moves = next.moves.slice(-BOARD_MOVES_KEPT);
      }
      // Негодный снимок не пишется: иначе следующее чтение доски упало бы на своём же файле (W2-D).
      const checked = boardFileSchema.safeParse(next);
      if (!checked.success)
        throw new BoardStoreError(`board write refused: ${checked.error.message}`);
      // Сначала диск, потом память: упавшая запись не оставляет в памяти ход, которого нет на диске.
      write(path, `${JSON.stringify(next)}\n`);
      cache = next;
      return outcome;
    },
    entry(entryId) {
      const found = load().entries.find((e) => e.entryId === entryId);
      return found ? structuredClone(found) : undefined;
    },
    reset() {
      cache = null;
    },
  };
}
