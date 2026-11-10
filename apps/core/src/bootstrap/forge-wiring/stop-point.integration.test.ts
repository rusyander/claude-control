import { afterEach, describe, expect, it } from 'vitest';
import type { BoardStop } from '@agentdeck/contracts/core/board';
import type { CreateSeed } from '../../conductor/estimate/index.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { REAL_PUBLISH_TIMEOUT_MS } from '../guard-wiring/__fixtures__/guard-stand.ts';
import {
  closeWorlds,
  linesOf,
  tasksBesides,
  tick,
  world,
  type World,
} from './__fixtures__/answer-world.ts';

/**
 * Точка остановки на стороне форжа (этап 12, P157, D7) на настоящем пути: настоящий реестр,
 * оценка, публикатор, заглушка форжа на loopback и настоящий опрос (`createPollWiring`).
 * «До MR» — MR не смотрится даже в репозитории из `forgePoll`; «до конца» — смотрится и вне него,
 * носитель ответов открывается сам (`auto`) с тем же `boardEntry`; без доски — как настроен
 * репозиторий.
 */

afterEach(closeWorlds);

function entry(stop: BoardStop) {
  return {
    entryId: newId(),
    stop,
    source: 'manual' as const,
    proof: { kind: 'human' as const, cmdId: newId() },
  };
}

const boardSeed = (e: ReturnType<typeof entry>): CreateSeed => ({
  created: () => ({ boardEntry: e }),
});

async function note(w: World, mrIid: number, body: string): Promise<void> {
  w.stub.act('reviewer', { type: 'note', mrIid, body });
}

describe('stop point on the forge side (P157)', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('stop «mr» in a forgePoll repo: a reviewer note opens no carrier, while the plain MR of the same repo still gets one', async () => {
    const w = await world();
    const mrStop = await w.publishSource('Board task to MR', 'board-mr', boardSeed(entry('mr')));
    w.enable();
    const poller = w.poller();
    expect((await poller.tick()).requested).toBe(0);
    await tick();
    await note(w, mrStop.mrIid, 'please rename');
    await note(w, w.mrIid, 'please fix');
    const got = await poller.tick();
    expect(got).toMatchObject({ requested: 1, unknown: {} });
    const [carrierId, more] = tasksBesides(w, [w.source.taskId, mrStop.source.taskId]);
    expect(more).toBeUndefined();
    const carrier = w.registry.live(carrierId!)!;
    // Носитель — у MR без доски (репозиторий настроен), не у «до MR».
    expect(linesOf(carrier, 'publish.mr').map((m) => m['mrIid'])).toEqual([w.mrIid]);
    expect(carrier.state.created!.title).toBe('Add the feature file');
    expect(carrier.state.created!.launchPolicy).toBe('confirm');
    expect(carrier.state.created!.boardEntry).toBeUndefined();
  });

  it('stop «end» outside forgePoll: its MR is watched, the carrier opens auto with the source boardEntry; the plain MR of the unconfigured repo is not', async () => {
    const w = await world();
    const e = entry('end');
    const endStop = await w.publishSource('Board task to the end', 'board-end', boardSeed(e));
    // Конфига `forgePoll` нет вовсе: опрос включается только остановкой «до конца».
    const poller = w.poller();
    expect((await poller.tick()).requested).toBe(0);
    await tick();
    await note(w, endStop.mrIid, 'please rename');
    await note(w, w.mrIid, 'please fix');
    const got = await poller.tick();
    expect(got).toMatchObject({ requested: 1, unknown: {} });
    const [carrierId, more] = tasksBesides(w, [w.source.taskId, endStop.source.taskId]);
    expect(more).toBeUndefined();
    const created = w.registry.live(carrierId!)!.state.created!;
    expect(created.title).toBe('Board task to the end');
    expect(created.launchPolicy).toBe('auto');
    expect(created.boardEntry).toEqual(e);
  });

  it('no boardEntry and no forgePoll: nothing is polled at all (repo-level behaviour kept)', async () => {
    const w = await world();
    const poller = w.poller();
    await poller.tick();
    await tick();
    await note(w, w.mrIid, 'please fix');
    const got = await poller.tick();
    expect(got).toMatchObject({ requested: 0, polled: [] });
    expect(tasksBesides(w, [w.source.taskId])).toEqual([]);
  });
});
