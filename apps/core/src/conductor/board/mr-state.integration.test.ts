import { afterEach, describe, expect, it } from 'vitest';
import { boardMrReader } from '../../bootstrap/board-wiring.ts';
import {
  closeWorlds,
  linesOf,
  world,
  type World,
} from '../../bootstrap/forge-wiring/__fixtures__/answer-world.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { ask } from './__fixtures__/task-lines.ts';
import { createMrStateSweep } from './mr-state.ts';
import { createTaskReader } from './read.ts';
import { columnOfTask, taskCard } from './stage.ts';

/**
 * Обход конца MR (B10b) на настоящем пути: опубликованная и законченная задача (стенд ответов —
 * настоящий публикатор, голый «сервер», заглушка форжа по HTTP), читатель доски (`unitMrOf` →
 * сервер репозитория → `ForgePort.mr`), запись в журнал и колонка карточки из свёртки.
 */

afterEach(closeWorlds);

const AT = 1_234;

function sweeper(w: World) {
  const urls: string[] = [];
  const notes: string[] = [];
  const sweep = createMrStateSweep({
    tasks: createTaskReader({ registry: w.registry }),
    registry: w.registry,
    reader: () =>
      boardMrReader(
        w.registry,
        (url) => {
          urls.push(url);
          return w.port;
        },
        w.git,
      ),
    now: () => AT,
    note: (m) => notes.push(m),
  });
  return { sweep, urls, notes };
}

/** Чтения MR у заглушки (не служебные запросы управления). */
const mrReads = (w: World) =>
  w.stub.requests.filter(
    (r) => !r.control && r.method === 'GET' && /\/merge_requests\/\d+$/.test(r.path),
  ).length;

const stateOf = (w: World, taskId: string) =>
  w.registry.live(taskId)?.state ?? w.registry.view(taskId)!;

describe('MR state sweep (B10b)', () => {
  it('MR merged at the forge: one sweep writes publish.mr-state merged and the card moves to merged', async () => {
    const w = await world();
    const id = w.source.taskId;
    expect(columnOfTask(stateOf(w, id))).toBe('mr');
    const { sweep, urls } = sweeper(w);

    // Открытый MR — ничего не пишется.
    let report = await sweep.sweep();
    expect(report).toMatchObject({ read: 1, written: [] });
    expect(linesOf(w.source, 'publish.mr-state')).toEqual([]);

    w.stub.act('reviewer', { type: 'merge', mrIid: w.mrIid });
    report = await sweep.sweep();
    expect(report.written).toEqual([{ taskId: id, unitId: w.unitId, state: 'merged' }]);
    expect(linesOf(w.source, 'publish.mr-state')).toEqual([
      { unitId: w.unitId, state: 'merged', at: AT },
    ]);
    const card = taskCard(stateOf(w, id));
    expect(card.column).toBe('merged');
    expect(card.mr?.state).toBe('merged');
    // Форж выбран по адресу сервера репозитория единицы — голому репозиторию стенда.
    expect(urls.every((u) => u === w.st.bare)).toBe(true);

    // Конец записан — задача больше не цель: следующий обход форж не читает.
    const before = mrReads(w);
    expect((await sweep.sweep()).read).toBe(0);
    expect(mrReads(w)).toBe(before);
  });

  it('MR closed at the forge on a task no longer open in this core: it is opened and moves to closed', async () => {
    const w = await world();
    const id = w.source.taskId;
    w.registry.drop(id);
    expect(w.registry.live(id)).toBeUndefined();
    w.stub.act('reviewer', { type: 'mr-close', mrIid: w.mrIid });
    const { sweep } = sweeper(w);
    const report = await sweep.sweep();
    expect(report.written).toEqual([{ taskId: id, unitId: w.unitId, state: 'closed' }]);
    const lines = readJournalLines(w.source.dir, id).lines.filter(
      (l) => l.kind === 'publish.mr-state',
    );
    expect(lines.map((l) => l.data)).toEqual([{ unitId: w.unitId, state: 'closed', at: AT }]);
    expect(columnOfTask(stateOf(w, id))).toBe('closed');
  });

  it('an unknown read (forge 5xx) leaves the card unchanged and names the reason', async () => {
    const w = await world();
    const id = w.source.taskId;
    w.stub.act('reviewer', { type: 'merge', mrIid: w.mrIid });
    w.stub.fault({ kind: 'status', status: 503, path: '/merge_requests/\\d+$' });
    const { sweep, notes } = sweeper(w);
    const report = await sweep.sweep();
    expect(report.written).toEqual([]);
    expect(report.unchanged).toEqual([
      { taskId: id, unitId: w.unitId, why: expect.stringContaining('http 503') },
    ]);
    expect(linesOf(w.source, 'publish.mr-state')).toEqual([]);
    expect(columnOfTask(stateOf(w, id))).toBe('mr');
    expect(notes.some((n) => n.includes('http 503'))).toBe(true);
    // Форж ответил — следующий обход дописывает конец.
    w.stub.clearFaults();
    expect((await sweep.sweep()).written).toHaveLength(1);
  });

  it('only tasks in the MR column are read: a task waiting for the human with its own MR is not', async () => {
    const w = await world();
    const second = await w.publishSource('Add the second file', 'second');
    // Блокирующий вопрос ставит вторую задачу в «Ждёт вас» поверх колонки MR.
    ask(second.source, null);
    const columns = [w.source.taskId, second.source.taskId].map((t) => columnOfTask(stateOf(w, t)));
    expect(columns[0]).toBe('mr');
    expect(columns[1]).toBe('waiting');
    w.stub.act('reviewer', { type: 'merge', mrIid: second.mrIid });
    const before = mrReads(w);
    const { sweep } = sweeper(w);
    const report = await sweep.sweep();
    expect(report.read).toBe(1);
    expect(mrReads(w) - before).toBe(1);
    expect(linesOf(second.source, 'publish.mr-state')).toEqual([]);
  });
});
