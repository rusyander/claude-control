import { afterEach, describe, expect, it } from 'vitest';
import type { BoardEntry } from '@agentdeck/contracts/core/board';
import { newId } from '../../lib/ids/uuidv7.ts';
import {
  fieldsDraft,
  startBoardStand,
  type BoardStand,
} from '../../bootstrap/__fixtures__/board-stand.ts';
import {
  answered,
  ask,
  cancelled,
  newTask,
  running,
  session,
  step,
  unit,
} from './__fixtures__/task-lines.ts';
import { addEntries } from './moves.ts';
import { createBoardStore } from './store.ts';

/**
 * Запускатель доски по настоящей проводке (этап 12, B3; P153–P156, P183): сутки по поясу человека,
 * «стоп на вопросе», место задачи, которая ждёт, но чья модель ещё говорит, и доказательство записи
 * настройки, перепроверенное на старте. Часы доски — подменённые (`now` стенда); пояс — настоящий
 * пояс процесса теста (пул vitest `forks`: процесс на файл).
 */

// UTC+5 без летнего времени: местная полночь — 19:00 UTC, сутки по UTC и по поясу расходятся.
process.env.TZ = 'Asia/Yekaterinburg';

const stands: BoardStand[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

async function stand(opts: Parameters<typeof startBoardStand>[0] = {}): Promise<BoardStand> {
  const s = await startBoardStand(opts);
  stands.push(s);
  return s;
}

async function entry(b: BoardStand, id: string): Promise<BoardEntry> {
  const found = (await b.board()).entries.find((e) => e.entryId === id);
  if (!found) throw new Error(`no entry ${id}`);
  return found;
}

describe('board launcher limits (B3, P154, P155)', () => {
  it('perDay counts the local day of the human: after local midnight (same UTC day) the next one starts', async () => {
    let clock = Date.parse('2026-11-08T23:30:00+05:00');
    const b = await stand({ now: () => clock });
    expect(new Date(clock).getHours()).toBe(23);
    await b.setBoard({ inWork: 4, perDay: 1 });
    const made = await b.entries('queue', [
      fieldsDraft(b.repo, 'Late'),
      fieldsDraft(b.repo, 'Next'),
    ]);
    const [late, next] = made.body.created as [string, string];
    await b.settle();
    expect((await entry(b, late)).state).toBe('started');
    expect((await entry(b, next)).state).toBe('queued');
    expect((await b.board()).limits.perDay).toEqual({ used: 1, cap: 1 });

    // 00:10 по поясу человека — новые сутки; по UTC это всё ещё 8 ноября.
    clock = Date.parse('2026-11-09T00:10:00+05:00');
    expect(new Date(clock).toISOString().slice(0, 10)).toBe('2026-11-08');
    expect((await b.board()).limits.perDay).toEqual({ used: 0, cap: 1 });
    await b.settle();
    expect((await entry(b, next)).state).toBe('started');
  });

  it('stopOnQuestion: a blocking question anywhere holds the queue; answered, the head starts', async () => {
    const b = await stand();
    await b.setBoard({ inWork: 4, stopOnQuestion: true });
    const t = await newTask(b.s.registry);
    running(t);
    step(t, unit(t), 'work');
    const askId = ask(t, null);
    const made = await b.entries('queue', [fieldsDraft(b.repo, 'Waits for the answer')]);
    const id = made.body.created[0]!;
    await b.settle();
    expect((await entry(b, id)).state).toBe('queued');
    // Неблокирующий вопрос очередь не держит — держит только тот, что без действия по умолчанию.
    answered(t, askId);
    ask(t, 'continue');
    await b.settle();
    expect((await entry(b, id)).state).toBe('started');
  });

  it('a task that waits for the human while its model session is still open keeps its slot (P153)', async () => {
    const b = await stand();
    await b.setBoard({ inWork: 1 });
    const t = await newTask(b.s.registry);
    running(t);
    step(t, unit(t), 'work');
    ask(t, null);
    session(t);
    const made = await b.entries('queue', [fieldsDraft(b.repo, 'Behind a talking model')]);
    const id = made.body.created[0]!;
    await b.settle();
    expect((await entry(b, id)).state).toBe('queued');
    expect((await b.board()).limits.inWork).toEqual({ used: 1, cap: 1 });
    cancelled(t);
    await b.settle();
    expect((await entry(b, id)).state).toBe('started');
  });
});

describe('board start proof (B3, P183)', () => {
  async function seeded(proofCmd: 'missing' | 'real'): Promise<{ b: BoardStand; id: string }> {
    let id = '';
    const b = await stand({
      // Запись очереди с доказательством «запись настройки» лежит в доме до загрузки ядра.
      seed: async ({ s, repo, setBoard }) => {
        const real = await setBoard({ inWork: 4 });
        const store = createBoardStore({ root: s.layout.root });
        store.update(null, Date.now(), (file) => {
          [id] = addEntries(
            file,
            { cmdId: newId(), to: 'queue', entries: [fieldsDraft(repo, 'Auto-queued')] },
            Date.now(),
            'mr',
            newId,
          ) as [string];
          const e = file.entries.find((x) => x.entryId === id)!;
          e.proof = { kind: 'config', cmdId: proofCmd === 'real' ? real : newId() };
          return { ok: true };
        });
      },
    });
    return { b, id };
  }

  it('a config proof whose write is not in the config history goes back to the inbox with the reason', async () => {
    const { b, id } = await seeded('missing');
    await b.settle();
    const e = await entry(b, id);
    expect(e.state).toBe('inbox');
    expect(e.reason).toMatch(/is not in the config history/);
    expect([e.proof, e.cmdId, e.startedAt]).toEqual([undefined, undefined, undefined]);
    expect(b.s.registry.liveTasks().some((t) => t.state.created?.boardEntry?.entryId === id)).toBe(
      false,
    );
  });

  it('a real config write is not enough while auto-queue for the source is off: back to the inbox', async () => {
    const { b, id } = await seeded('real');
    await b.settle();
    const e = await entry(b, id);
    expect(e.state).toBe('inbox');
    expect(e.reason).toMatch(/auto-queue is off for manual sources/);
  });
});
