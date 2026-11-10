import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardEntry } from '@agentdeck/contracts/core/board';
import { newId } from '../../lib/ids/uuidv7.ts';
import {
  fieldsDraft,
  startBoardStand,
  type BoardStand,
} from '../../bootstrap/__fixtures__/board-stand.ts';
import { testEnv } from '../split/__fixtures__/split-stand.ts';
import { startEntry } from './start.ts';
import { BOARD_FILE } from './store.ts';

/**
 * Крах посреди старта записи (этап 12, P155, D4): запись осталась в `starting` со своим ключом
 * повтора. Загрузка проводки доски зовёт тот же путь с тем же ключом — задача, созданная до краха,
 * находится повтором оценки, а не создаётся второй; старт, до задачи не дошедший, создаёт ровно одну.
 * Настоящие оценка, реестр, git и файл доски — как их оставил бы прерванный процесс.
 */

const stands: BoardStand[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

function startingEntry(repo: string, title: string, at: number): BoardEntry {
  return {
    entryId: newId(),
    state: 'starting',
    rank: 0,
    stop: 'mr',
    preset: 'feature',
    source: { kind: 'manual', title },
    launch: fieldsDraft(repo, title).launch,
    proof: { kind: 'human', cmdId: newId(), at },
    cmdId: newId(),
    createdAt: at,
    startedAt: at,
  };
}

describe('board launcher after a crash in starting (P155)', () => {
  it('an entry left in starting re-calls the same road with its cmdId: the task made before the crash is found, a start that made none makes exactly one', async () => {
    const at = Date.now();
    let made: { entry: BoardEntry; taskId: string } | undefined;
    let bare: BoardEntry | undefined;
    const b = await startBoardStand({
      seed: async ({ s, repo, setBoard }) => {
        // Предел 1 занят задачей до краха: продолжение старта пределов не судит, оно доводит начатое.
        await setBoard({ inWork: 1 });
        const env = testEnv(join(s.layout.root, 'pre-crash-scenarios'));
        const entry = startingEntry(repo, 'Made before the crash', at);
        const out = await startEntry(entry, {
          registry: s.registry,
          layout: s.layout,
          split: () => env,
        });
        if (!('taskId' in out)) throw new Error(`pre-crash start refused: ${out.refused}`);
        made = { entry, taskId: out.taskId };
        bare = { ...startingEntry(repo, 'Crashed before its task', at), rank: 1 };
        writeFileSync(
          join(s.layout.root, BOARD_FILE),
          `${JSON.stringify({ v: 1, entries: [entry, bare], moves: [] })}\n`,
        );
      },
    });
    stands.push(b);
    await b.settle();
    const board = await b.board();
    const one = board.entries.find((e) => e.entryId === made!.entry.entryId)!;
    const two = board.entries.find((e) => e.entryId === bare!.entryId)!;
    expect(one).toMatchObject({ state: 'started', taskId: made!.taskId, cmdId: made!.entry.cmdId });
    expect(two.state).toBe('started');
    expect(two.taskId).toBeDefined();
    expect(two.taskId).not.toBe(made!.taskId);
    // Ровно по задаче на запись: повтор оценки нашёл первую, вторая создана один раз своим ключом.
    const byEntry = (entryId: string) =>
      b.s.registry.list().filter((t) => {
        const created = (b.s.registry.live(t.taskId)?.state ?? b.s.registry.view(t.taskId))
          ?.created;
        return created?.boardEntry?.entryId === entryId;
      });
    expect(byEntry(made!.entry.entryId).map((t) => t.taskId)).toEqual([made!.taskId]);
    const second = byEntry(bare!.entryId);
    expect(second.map((t) => t.taskId)).toEqual([two.taskId]);
    const secondCreated = b.s.registry.view(two.taskId!)?.created;
    expect(secondCreated?.origin).toEqual({ cmdId: bare!.cmdId });
  });
});
