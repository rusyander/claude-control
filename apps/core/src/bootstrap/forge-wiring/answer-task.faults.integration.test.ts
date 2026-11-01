import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { failHalfMadeAnswers, HALF_MADE_ANSWER_REASON } from '../../conductor/estimate/index.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { deps as journalDeps } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import {
  answerThroughPublish,
  closeWorlds,
  linesOf,
  tasksBesides,
  tick,
  world,
} from './__fixtures__/answer-world.ts';
import { REAL_PUBLISH_TIMEOUT_MS } from '../guard-wiring/__fixtures__/guard-stand.ts';
import { createPollWiring, FORGE_POLL_STATE } from './poll-wiring.ts';

/**
 * Сбои открытия задачи ответов на настоящем пути (ревью F2, F3, F6): отказ при создании — не
 * открытая задача, заметка не съедена; крах посреди создания — недоделанная задача держит MR и
 * её заметка второй задачи не открывает; слитый MR больше не наблюдается.
 */

afterEach(closeWorlds);

const eventIds = (dir: string, taskId: string) =>
  readJournalLines(dir, taskId)
    .lines.filter((l) => l.kind === 'forge.event')
    .map((l) => (l.data as { forgeEventId: string }).forgeEventId);

describe('answer task: refusal and crash at creation', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('F3: a failed preflight is a refusal — no answer task, the note is not consumed and opens the task once the cause is gone', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    await poller.tick();
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
    const real = w.env.preflight;
    w.env.preflight = async (...args) => ({ ...(await real(...args)), start: false });
    const refused = await poller.tick();
    expect(refused.requested).toBe(0);
    expect(tasksBesides(w, [w.source.taskId])).toEqual([]);
    expect(w.notes.some((n) => /AnswerTaskRefused/.test(String(n.data.message)))).toBe(true);
    expect(w.notes.filter((n) => n.event === 'forge.poll.opened')).toEqual([]);
    w.env.preflight = real;
    expect((await poller.tick()).requested).toBe(1);
    const [answerId] = tasksBesides(w, [w.source.taskId]);
    const answer = w.registry.live(answerId!)!;
    expect(answer.state.ended).toBeNull();
    expect(Object.keys(answer.state.units)).toHaveLength(1);
    expect(linesOf(answer, 'forge.event')).toEqual([
      expect.objectContaining({ source: 'poller', author: 'reviewer' }),
    ]);
  });

  it('F2: a throw after the forge.event lines ends the half-made task failed; the next round opens exactly one live answer task', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    await poller.tick();
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
    w.env.history = async () => {
      throw new Error('history store broke mid-creation');
    };
    expect((await poller.tick()).requested).toBe(0);
    const [half] = tasksBesides(w, [w.source.taskId]);
    expect(half).toBeDefined();
    const halfState = w.registry.live(half!)?.state ?? w.registry.view(half!)!;
    expect(halfState.ended).toBe('failed');
    expect(Object.keys(halfState.units)).toEqual([]);
    delete w.env.history;
    expect((await poller.tick()).requested).toBe(1);
    const live = w.registry.list().filter((t) => t.taskId !== w.source.taskId && t.ended === null);
    expect(live).toHaveLength(1);
    expect((await poller.tick()).requested).toBe(0);
  });

  it('F3: a scenario refusal (broken project overlay) is a refusal — no task, the note opens the task once the file is fixed', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    await poller.tick();
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
    const overlay = join(w.st.main, '.agentdeck', 'scenario.json');
    mkdirSync(dirname(overlay), { recursive: true });
    writeFileSync(overlay, '{ not json');
    expect((await poller.tick()).requested).toBe(0);
    expect(tasksBesides(w, [w.source.taskId])).toEqual([]);
    expect(w.notes.some((n) => /AnswerTaskRefused.*not JSON/.test(String(n.data.message)))).toBe(
      true,
    );
    rmSync(dirname(overlay), { recursive: true, force: true });
    expect((await poller.tick()).requested).toBe(1);
    expect(tasksBesides(w, [w.source.taskId])).toHaveLength(1);
  });

  it('F2 (review repro R2): preflight throws once — the next round opens exactly one answer task, the note carried once', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    await poller.tick();
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
    const real = w.env.preflight;
    w.env.preflight = () => Promise.reject(new Error('core died here'));
    expect((await poller.tick()).requested).toBe(0);
    w.env.preflight = real;
    expect((await poller.tick()).requested).toBe(1);
    const others = tasksBesides(w, [w.source.taskId]);
    // До разбора: две задачи, обе с `note:<id>`. Теперь задача одна, и ни одной недоделанной.
    expect(others).toHaveLength(1);
    expect(eventIds(join(w.registry.tasksDir, others[0]!), others[0]!)).toHaveLength(1);
    expect(w.registry.live(others[0]!)!.state.ended).toBeNull();
  });

  it('F2: a crash after the forge.event lines (restart with the half-made task) holds the MR — no duplicate task for the same note', async () => {
    const w = await world();
    w.enable();
    await w.poller().tick();
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
    // Создание висит после строк `forge.event` — ядро «умирает» здесь.
    let release: () => void = () => undefined;
    w.env.history = () =>
      new Promise((resolve) => {
        release = () => resolve(null);
      });
    const dying = w.poller().tick();
    let half: string | undefined;
    for (let i = 0; i < 400 && !half; i += 1) {
      await tick();
      half = tasksBesides(w, [w.source.taskId]).find(
        (id) => eventIds(join(w.registry.tasksDir, id), id).length > 0,
      );
    }
    expect(half).toBeDefined();
    // Перезапуск: новый реестр и новый опрос над тем же домом ядра.
    const registry = createTaskRegistry(w.layout.tasks, journalDeps());
    const restarted = createPollWiring({
      registry,
      // Новый процесс — новая среда: история читается, висит только задача «умершего» ядра.
      split: () => ({ ...w.env, history: async () => null }),
      layout: w.layout,
      note: (event, data) => w.notes.push({ event, data }),
      git: w.git,
      forgeFor: () => w.port,
    });
    try {
      expect((await restarted.tick()).requested).toBe(0);
      const others = registry
        .list()
        .map((t) => t.taskId)
        .filter((id) => id !== w.source.taskId);
      expect(others).toEqual([half]);
      // Недоделанная задача держит MR: новая заметка ждёт её конца, а не открывает задачу рядом.
      await tick();
      w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'one more while half-made' });
      expect((await restarted.tick()).requested).toBe(0);
      expect(registry.list().filter((t) => t.taskId !== w.source.taskId)).toHaveLength(1);
      const marks = JSON.parse(
        readFileSync(join(w.layout.root, FORGE_POLL_STATE), 'utf8'),
      ) as Record<string, { pending?: Record<string, unknown[]> }>;
      expect(Object.values(marks)[0]!.pending?.[String(w.mrIid)]).toHaveLength(1);
    } finally {
      registry.closeAll();
      release();
      await dying;
    }
  });

  it('crash residual: the restarted core opens the half-made task and ends it failed with a named reason — the MR is released and the note reopens one live task', async () => {
    const w = await world();
    w.enable();
    await w.poller().tick();
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
    let release: () => void = () => undefined;
    w.env.history = () =>
      new Promise((resolve) => {
        release = () => resolve(null);
      });
    const dying = w.poller().tick();
    let half: string | undefined;
    for (let i = 0; i < 400 && !half; i += 1) {
      await tick();
      half = tasksBesides(w, [w.source.taskId]).find(
        (id) => eventIds(join(w.registry.tasksDir, id), id).length > 0,
      );
    }
    expect(half).toBeDefined();
    // Ядро «умерло»: его аренды отпущены, новый реестр открывает незаконченные, как загрузка.
    w.registry.closeAll();
    const registry = createTaskRegistry(w.layout.tasks, journalDeps());
    const restarted = createPollWiring({
      registry,
      split: () => ({ ...w.env, history: async () => null }),
      layout: w.layout,
      note: (event, data) => w.notes.push({ event, data }),
      git: w.git,
      forgeFor: () => w.port,
    });
    try {
      const opened = await registry.openUnfinished();
      expect(opened.opened).toContain(half);
      expect(failHalfMadeAnswers(registry, opened.opened)).toEqual([half]);
      const ended = registry.live(half!)!;
      expect(ended.state.ended).toBe('failed');
      expect(linesOf(ended, 'signal')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ detail: JSON.stringify([HALF_MADE_ANSWER_REASON]) }),
        ]),
      );
      // Законченный источник и задачи с единицей не тронуты.
      expect(failHalfMadeAnswers(registry, [w.source.taskId, half!])).toEqual([]);
      // MR отпущен: та же заметка открывает ровно одну живую задачу ответов.
      expect((await restarted.tick()).requested).toBe(1);
      const live = registry.list().filter((t) => t.taskId !== w.source.taskId && t.ended === null);
      expect(live).toHaveLength(1);
      expect(Object.keys(registry.live(live[0]!.taskId)!.state.units)).toHaveLength(1);
    } finally {
      registry.closeAll();
      release();
      await dying.catch(() => undefined);
    }
  });
});

describe('answer task: what it read is its own (F5)', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('a note posted while the answer task waits and read by its publication opens nothing; a note after that read opens the next task', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    await poller.tick();
    await tick();
    const n1 = w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'N1: rename' }) as {
      id: string;
    };
    expect((await poller.tick()).requested).toBe(1);
    const [b] = tasksBesides(w, [w.source.taskId]);
    const answer = w.registry.live(b!)!;
    await tick();
    // MR удержан задачей B — заметка N2 ждёт; B публикуется и читает нити MR, N2 в них есть.
    const n2 = w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'N2: also this' }) as {
      id: string;
    };
    expect((await poller.tick()).requested).toBe(0);
    const got = await answerThroughPublish(w, answer, {
      file: 'feature.txt',
      text: 'renamed\n',
      replies: [
        { threadId: n1.id, text: 'Renamed.', resolve: true },
        { threadId: n2.id, text: 'Done too.', resolve: true },
      ],
    });
    expect(got).toEqual({ published: { kind: 'published', mrIid: w.mrIid } });
    const read = linesOf(answer, 'publish.read')[0]!;
    expect((read.threads as { id: string }[]).map((t) => t.id).sort()).toEqual(
      [n1.id, n2.id].sort(),
    );
    answer.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    // B закончена `done` — N2 прочитана ею: третьей задачи нет.
    expect((await poller.tick()).requested).toBe(0);
    expect(tasksBesides(w, [w.source.taskId, b!])).toEqual([]);
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'N3: after the read' });
    expect((await poller.tick()).requested).toBe(1);
    const [c] = tasksBesides(w, [w.source.taskId, b!]);
    const events = linesOf(w.registry.live(c!)!, 'forge.event');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ author: 'reviewer', mrIid: w.mrIid });
  });
});

describe(
  'answer task: the copy goes through the conductor road (F10)',
  { timeout: REAL_PUBLISH_TIMEOUT_MS },
  () => {
    it('the local MR branch moved after the answer task was made: the copy refuses with both commits named, nothing is pushed', async () => {
      const w = await world();
      w.enable();
      const poller = w.poller();
      await poller.tick();
      await tick();
      w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
      expect((await poller.tick()).requested).toBe(1);
      const [answerId] = tasksBesides(w, [w.source.taskId]);
      const answer = w.registry.live(answerId!)!;
      const head = w.st.g(w.st.bare, 'rev-parse', `refs/heads/${w.branch}`);
      // Человек закоммитил в локальную ветку MR уже после создания задачи ответов.
      const side = join(w.st.root, 'side');
      w.st.g(w.st.main, 'worktree', 'add', '-q', side, w.branch);
      w.st.commitIn(side, 'local-only.txt');
      w.st.g(w.st.main, 'worktree', 'remove', '--force', side);
      const moved = w.st.g(w.st.main, 'rev-parse', `refs/heads/${w.branch}`);
      expect(moved).not.toBe(head);
      const got = await answerThroughPublish(w, answer, {
        file: 'feature.txt',
        text: 'renamed\n',
        replies: [],
      });
      expect(got).toEqual({ copyFailed: expect.stringContaining(moved.slice(0, 12)) as string });
      expect('copyFailed' in got && got.copyFailed).toContain(head.slice(0, 12));
      // Ни копии, ни пуша: голова MR на сервере та же.
      expect(w.st.g(w.st.bare, 'rev-parse', `refs/heads/${w.branch}`)).toBe(head);
      expect(w.st.g(w.st.main, 'worktree', 'list', '--porcelain')).not.toContain(w.branch);
    });
  },
);

describe(
  'answer task: the push url carries no secret into the core home (F9)',
  { timeout: REAL_PUBLISH_TIMEOUT_MS },
  () => {
    it('a token in the remote push url is stripped from the poll state, the core notes and the forge.event target', async () => {
      const w = await world();
      const secret = 'glpat-s3cr3t-token';
      w.st.g(
        w.st.main,
        'config',
        'remote.origin.pushurl',
        `https://oauth2:${secret}@forge.example.test/acme/app.git`,
      );
      w.enable();
      const poller = w.poller();
      await poller.tick();
      await tick();
      w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
      expect((await poller.tick()).requested).toBe(1);
      const [answerId] = tasksBesides(w, [w.source.taskId]);
      const answer = w.registry.live(answerId!)!;
      const state = readFileSync(join(w.layout.root, FORGE_POLL_STATE), 'utf8');
      expect(state).not.toContain(secret);
      expect(Object.keys(JSON.parse(state) as object)).toEqual([
        'https://forge.example.test/acme/app.git',
      ]);
      expect(JSON.stringify(w.notes)).not.toContain(secret);
      expect(linesOf(answer, 'forge.event')).toEqual([
        expect.objectContaining({ target: `https://forge.example.test/acme/app.git !${w.mrIid}` }),
      ]);
    });
  },
);

describe(
  'answer task: a merged MR is no longer watched (F6)',
  { timeout: REAL_PUBLISH_TIMEOUT_MS },
  () => {
    it('a note on a merged MR opens nothing; the MR is retired in the poll state with its reason', async () => {
      const w = await world();
      w.enable();
      const poller = w.poller();
      await poller.tick();
      await tick();
      w.stub.act('reviewer', { type: 'merge', mrIid: w.mrIid });
      w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'thanks, merged' });
      expect((await poller.tick()).requested).toBe(0);
      expect(tasksBesides(w, [w.source.taskId])).toEqual([]);
      const marks = JSON.parse(
        readFileSync(join(w.layout.root, FORGE_POLL_STATE), 'utf8'),
      ) as Record<string, { retired?: Record<string, string> }>;
      expect(Object.values(marks)[0]!.retired).toEqual({ [String(w.mrIid)]: 'merged' });
      expect(w.notes.some((n) => /retired.*merged/.test(String(n.data.message)))).toBe(true);
      // Следующий круг этот MR даже не читает.
      const before = w.stub.requests.length;
      await poller.tick();
      expect(
        w.stub.requests.slice(before).filter((r) => r.path.includes(`/merge_requests/${w.mrIid}`)),
      ).toEqual([]);
    });
  },
);
