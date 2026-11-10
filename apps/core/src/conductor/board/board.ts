import type { BoardReply } from '@agentdeck/contracts/core/board';
import type { BoardSection } from '@agentdeck/contracts/core/config';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { BoardPort } from './board.types.ts';
import { addEntries, applyMove, draftProblems, type MoveRefusal } from './moves.ts';
import { boardReplyOf, type TaskReader } from './read.ts';
import type { BoardStore } from './store.types.ts';

/**
 * Доска как порт API (этап 12): снимок, ход человека, новые записи. Каждая запись хранилища
 * будит запускатель (`onWrite`): новая голова очереди стартует сразу, а не на следующем обходе.
 * Пределы для снимка — из раздела `board`; нечитаемая настройка — умолчания в снимке, а
 * запускатель при этом не стартует (он судит сам).
 */

export interface BoardCoreDeps {
  store: BoardStore;
  tasks: TaskReader;
  section(): BoardSection;
  /** Жалобы настройки, из-за которых `section()` — умолчания; пусто — пределы из настройки. */
  configIssues?(): { section: string; reason: string }[];
  now(): number;
  onWrite(): void;
  newId?: () => string;
}

export function createBoardPort(deps: BoardCoreDeps): BoardPort {
  const mint = deps.newId ?? newId;
  const snapshot = (): BoardReply => {
    const file = deps.store.read();
    const { states } = deps.tasks.states();
    const reply = boardReplyOf(file.entries, states, deps.section(), deps.now());
    const issues = deps.configIssues?.() ?? [];
    return issues.length > 0 ? { ...reply, configIssues: issues } : reply;
  };
  return {
    read: async () => snapshot(),
    async replayed(cmdId) {
      const done = deps.store.applied(cmdId);
      if (!done) return undefined;
      return { ...snapshot(), replayed: true, created: done.created ?? [] };
    },
    async move(move) {
      const done = deps.store.applied(move.cmdId);
      if (done) return { ok: true, reply: { ...snapshot(), replayed: true }, replayed: true };
      const at = deps.now();
      const outcome = deps.store.update<MoveRefusal>(move.cmdId, at, (file) => {
        const applied = applyMove(file, move, at);
        if (applied.ok) return { ok: true };
        const { ok: _ok, ...refusal } = applied;
        return { ok: false, refusal };
      });
      if (!outcome.ok) return { ok: false, ...outcome.refusal };
      deps.onWrite();
      return { ok: true, reply: { ...snapshot(), replayed: false }, replayed: false };
    },
    async entries(input) {
      const done = deps.store.applied(input.cmdId);
      if (done)
        return { ok: true, reply: { ...snapshot(), replayed: true, created: done.created ?? [] } };
      const problems = input.entries.flatMap((d, i) => draftProblems(d, i));
      if (problems.length > 0) return { ok: false, status: 422, code: 'entries-refused', problems };
      const at = deps.now();
      const stop = deps.section().defaultStop;
      const outcome = deps.store.update<never>(input.cmdId, at, (file) => ({
        ok: true,
        created: addEntries(file, input, at, stop, mint),
      }));
      const created = outcome.ok ? (outcome.created ?? []) : [];
      deps.onWrite();
      return { ok: true, reply: { ...snapshot(), replayed: false, created } };
    },
    intake(cmdId, change) {
      const at = deps.now();
      const stop = deps.section().defaultStop;
      const box: { value?: unknown; wrote: boolean } = { wrote: false };
      deps.store.update<null>(cmdId, at, (file) => {
        const got = change(file, { at, stop, newId: mint });
        box.value = got.value;
        if (!got.write) return { ok: false, refusal: null };
        box.wrote = true;
        return { ok: true, ...(got.created ? { created: got.created } : {}) };
      });
      if (box.wrote) deps.onWrite();
      return box.value as never;
    },
  };
}
