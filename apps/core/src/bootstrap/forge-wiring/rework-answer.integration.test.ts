import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openAnswerTaskFromMr } from '../../conductor/estimate/index.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { REAL_PUBLISH_TIMEOUT_MS } from '../guard-wiring/__fixtures__/guard-stand.ts';
import { createMrReader, createTakeoverWiring } from '../takeover-wiring.ts';
import {
  closeWorlds,
  linesOf,
  tasksBesides,
  world,
  type World,
} from './__fixtures__/answer-world.ts';

/**
 * Доработка готовой работы и дорога ответов по ссылке (этап 12, P162 P182) на настоящем пути:
 * настоящий реестр, оценка (голова MR приколота fetch'ем с голого «сервера»), заглушка форжа на
 * loopback. Носитель доработки — одна задача ответов на открытый MR со словом человека в запросе,
 * ключ — `cmdId` доработки. Свой MR, которого ядро не открывало, — задача ответов из нитей форжа
 * без журнала-источника.
 */

afterEach(closeWorlds);

function wiring(w: World) {
  return createTakeoverWiring({
    registry: w.registry,
    layout: w.layout,
    note: (event, data) => w.notes.push({ event, data }),
    split: () => w.env,
    config: {} as never,
    board: () => undefined,
    now: Date.now,
    git: w.git,
  });
}

const request = (w: World, taskId: string): string =>
  readFileSync(join(w.registry.tasksDir, taskId, 'request.md'), 'utf8');

describe(
  'rework of a done task with an open MR (P162)',
  { timeout: REAL_PUBLISH_TIMEOUT_MS },
  () => {
    it('one carrier on the same MR, launched auto, the note in its request; the same cmdId (also at once) → the same carrier', async () => {
      const w = await world();
      const port = wiring(w).rework()!;
      const cmdId = newId();
      const source = { taskId: w.source.taskId, state: w.source.state };
      const [a, b] = await Promise.all([
        port.carrier(source, cmdId, 'rename the file to final.txt'),
        port.carrier(source, cmdId, 'rename the file to final.txt'),
      ]);
      if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]));
      expect(b.carrierTaskId).toBe(a.carrierTaskId);
      const again = await port.carrier(source, cmdId, 'rename the file to final.txt');
      expect(again).toEqual({ ok: true, carrierTaskId: a.carrierTaskId });
      expect(tasksBesides(w, [w.source.taskId])).toEqual([a.carrierTaskId]);
      const carrier = w.registry.live(a.carrierTaskId)!;
      expect(carrier.state.created!.origin).toEqual({ cmdId });
      expect(carrier.state.created!.launchPolicy).toBe('auto');
      expect(carrier.state.created!.scenario.id).toBe('answer-reviewers');
      expect(request(w, a.carrierTaskId)).toContain('rename the file to final.txt');
      expect(linesOf(carrier, 'publish.mr').map((m) => m['mrIid'])).toEqual([w.mrIid]);
      // Без заметок форжа: причина — слово человека, строк опроса нет.
      expect(linesOf(carrier, 'forge.event')).toEqual([]);
    });

    it('another cmdId is another round: a second carrier', async () => {
      const w = await world();
      const port = wiring(w).rework()!;
      const source = { taskId: w.source.taskId, state: w.source.state };
      const a = await port.carrier(source, newId(), 'first');
      const b = await port.carrier(source, newId(), 'second');
      if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]));
      expect(b.carrierTaskId).not.toBe(a.carrierTaskId);
    });
  },
);

describe(
  'openAnswerTaskFromMr — an own MR the core never made (P182)',
  { timeout: REAL_PUBLISH_TIMEOUT_MS },
  () => {
    async function ownMr(w: World): Promise<{ url: string; iid: number }> {
      const branch = `hand/${newId().slice(-8)}`;
      w.st.g(w.st.main, 'checkout', '-q', '-b', branch, 'origin/main');
      w.st.g(w.st.main, 'commit', '-q', '--allow-empty', '-m', 'hand-made change');
      w.st.g(w.st.main, 'push', '-q', 'origin', branch);
      w.st.g(w.st.main, 'checkout', '-q', '-');
      const opened = w.stub.act('publisher', {
        type: 'mr-open',
        sourceBranch: branch,
        targetBranch: 'main',
        title: 'Hand-made',
      }) as { iid: number };
      const mr = await w.port.mr(opened.iid);
      if (!('value' in mr)) throw new Error(JSON.stringify(mr));
      return { url: mr.value.url, iid: opened.iid };
    }

    it('identity and unresolved threads come from the forge; the same cmdId → the same task', async () => {
      const w = await world();
      const mr = await ownMr(w);
      w.stub.act('reviewer', { type: 'note', mrIid: mr.iid, body: 'why this way?' });
      const reader = createMrReader(w.git, () => w.port);
      const cmdId = newId();
      const input = { cmdId, mrUrl: mr.url, repo: w.st.main, note: 'answer politely' };
      const got = await openAnswerTaskFromMr(input, reader, w.registry, w.env, w.git);
      if (!('opened' in got)) throw new Error(JSON.stringify(got));
      const task = w.registry.live(got.opened)!;
      expect(task.state.created!.scenario.id).toBe('answer-reviewers');
      expect(task.state.created!.launchPolicy).toBe('confirm');
      const [zeroId, zero] = Object.entries(task.state.units)[0]!;
      expect(zero.branch).toMatch(/^hand\//);
      expect(linesOf(task, 'publish.mr')).toEqual([
        expect.objectContaining({ unitId: zeroId, mrIid: mr.iid, url: mr.url, forge: 'gitlab' }),
      ]);
      const events = linesOf(task, 'forge.event');
      expect(events).toEqual([
        expect.objectContaining({ type: 'thread', author: 'reviewer', mrIid: mr.iid }),
      ]);
      expect(events[0]).not.toHaveProperty('source');
      expect(request(w, got.opened)).toContain('answer politely');
      const again = await openAnswerTaskFromMr(input, reader, w.registry, w.env, w.git);
      expect(again).toMatchObject({ opened: got.opened });
      expect(tasksBesides(w, [w.source.taskId, got.opened])).toEqual([]);
    });

    it('a link to another project with the same iid is refused, no task', async () => {
      const w = await world();
      const mr = await ownMr(w);
      const foreign = mr.url.replace(
        /\/([^/]+)\/-\/merge_requests\//,
        '/other-$1/-/merge_requests/',
      );
      expect(foreign).not.toBe(mr.url);
      const got = await openAnswerTaskFromMr(
        { cmdId: newId(), mrUrl: foreign, repo: w.st.main },
        createMrReader(w.git, () => w.port),
        w.registry,
        w.env,
        w.git,
      );
      expect(got).toMatchObject({ refused: [expect.stringContaining('not ' + foreign)] });
      expect(tasksBesides(w, [w.source.taskId])).toEqual([]);
    });

    it('a closed MR is refused', async () => {
      const w = await world();
      const mr = await ownMr(w);
      w.stub.act('reviewer', { type: 'merge', mrIid: mr.iid });
      const got = await openAnswerTaskFromMr(
        { cmdId: newId(), mrUrl: mr.url, repo: w.st.main },
        createMrReader(w.git, () => w.port),
        w.registry,
        w.env,
        w.git,
      );
      expect(got).toMatchObject({ refused: [expect.stringMatching(/is merged/)] });
    });
  },
);
