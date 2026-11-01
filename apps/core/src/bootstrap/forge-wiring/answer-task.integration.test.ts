import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  answerThroughPublish,
  closeWorlds,
  linesOf,
  tasksBesides,
  tick,
  world,
} from './__fixtures__/answer-world.ts';
import { REAL_PUBLISH_TIMEOUT_MS } from '../guard-wiring/__fixtures__/guard-stand.ts';
import type { GitRunner } from '../../platform/git/git.types.ts';
import { runTool } from '../../platform/run-tool.ts';
import { FORGE_POLL_STATE } from './poll-wiring.ts';

/**
 * Поздние заметки ревьюера → новая задача ответов (05:77-78, 01:61) на настоящем пути: основной
 * репозиторий и голый «сервер» во временной папке, заглушка форжа на loopback, настоящий реестр
 * задач, настоящая оценка (база приколота fetch'ем), настоящий публикатор. Задача-источник
 * публикует MR, человек включает опрос в конфиге ядра, ревьюер пишет — опрос открывает задачу
 * `answer-reviewers` на ветке MR с тем же MR и причиной в журнале, не запуская её; её ответ
 * уходит в нить MR тем же публикатором. Ни настоящего удалённого, ни настоящего форжа.
 */

afterEach(closeWorlds);

describe('forge poll → answer-reviewers task', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('a reviewer note on the finished task MR opens ONE answer task on the MR branch with the same MR, not launched', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    // Первый круг ставит отметку «сейчас»: история до включения — не повод.
    expect((await poller.tick()).requested).toBe(0);
    await tick();
    w.stub.act('publisher', { type: 'note', mrIid: w.mrIid, body: 'own note' });
    const thread = w.stub.act('reviewer', {
      type: 'note',
      mrIid: w.mrIid,
      body: 'please rename the file',
    }) as { id: string };
    const got = await poller.tick();
    expect(got).toMatchObject({ requested: 1, unknown: {} });
    const [answerId] = tasksBesides(w, [w.source.taskId]);
    expect(answerId).toBeDefined();
    const answer = w.registry.live(answerId!)!;

    const created = answer.state.created!;
    expect(created.scenario).toEqual({ id: 'answer-reviewers', version: 1 });
    expect(created.launchPolicy).toBe('confirm');
    expect(created.ciWait).toBe(false);
    expect(created.title).toBe('Add the feature file');
    // База — голова ветки MR НА СЕРВЕРЕ, приколотая fetch'ем.
    const head = w.st.g(w.st.bare, 'rev-parse', `refs/heads/${w.branch}`);
    expect(created.repos).toEqual([{ ...w.source.state.created!.repos[0]!, baseRef: head }]);
    // Единица 0 — на ветке MR, MR тот же (личность форжа), ключ — её единица.
    const units = Object.entries(answer.state.units);
    expect(units).toHaveLength(1);
    const [zeroId, zero] = units[0]!;
    expect(zero.branch).toBe(w.branch);
    const srcMr = linesOf(w.source, 'publish.mr')[0]!;
    expect(linesOf(answer, 'publish.mr')).toEqual([
      {
        ...srcMr,
        unitId: zeroId,
      },
    ]);
    // Причина — строки `forge.event` опроса: только заметка ревьюера, своя — нет.
    expect(linesOf(answer, 'forge.event')).toEqual([
      expect.objectContaining({
        source: 'poller',
        type: 'note',
        author: 'reviewer',
        mrIid: w.mrIid,
      }),
    ]);
    expect(thread.id).toBeTruthy();
    // Не запущена: ни шага, ни перехода в работу — запуск за человеком.
    expect(linesOf(answer, 'step.started')).toEqual([]);
    expect(answer.state.task).not.toBe('running');
    expect(w.notes.map((n) => n.event)).toContain('forge.poll.opened');

    // Повтор круга — второй задачи нет.
    expect((await poller.tick()).requested).toBe(0);
    expect(tasksBesides(w, [w.source.taskId, answerId!])).toEqual([]);
    // Опрос только читал форж: ни одной записи, кроме публикации задачи-источника.
    expect(w.stub.requests.some((r) => r.forbidden)).toBe(false);
  });

  it('opt-in only: no forgePoll in the core config (or another repository) opens nothing and reads nothing', async () => {
    const w = await world();
    const poller = w.poller();
    await poller.tick();
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
    const before = w.stub.requests.length;
    expect(await poller.tick()).toEqual({ polled: [], requested: 0, unknown: {} });
    w.enable([join(w.st.root, 'elsewhere')]);
    expect(await poller.tick()).toEqual({ polled: [], requested: 0, unknown: {} });
    expect(w.stub.requests.length).toBe(before);
    expect(tasksBesides(w, [w.source.taskId])).toEqual([]);
    // Выключенный опрос ничего не пишет и в дом ядра.
    expect(existsSync(join(w.layout.root, FORGE_POLL_STATE))).toBe(false);
  });

  it('a note while the answer task waits is not a second task; once it is done, the next note is watched under it', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    await poller.tick();
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'first' });
    expect((await poller.tick()).requested).toBe(1);
    const [answerId] = tasksBesides(w, [w.source.taskId]);
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'second' });
    // Задача ответов ещё ждёт запуска — MR не опрашивается, заметка не пропадает.
    expect((await poller.tick()).requested).toBe(0);
    expect(tasksBesides(w, [w.source.taskId, answerId!])).toEqual([]);
    const answer = w.registry.live(answerId!)!;
    answer.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    expect((await poller.tick()).requested).toBe(1);
    const [third] = tasksBesides(w, [w.source.taskId, answerId!]);
    const next = w.registry.live(third!)!;
    // Источник третьей — последняя законченная задача MR (задача ответов), заметка — вторая.
    expect(next.state.created!.scenario.id).toBe('answer-reviewers');
    const events = linesOf(next, 'forge.event');
    expect(events).toHaveLength(1);
    expect(events[0]!.forgeEventId).not.toBe(linesOf(answer, 'forge.event')[0]!.forgeEventId);
    expect(Object.values(next.state.units)[0]!.branch).toBe(w.branch);
  });

  it('a note on a held MR survives another MR of the same project moving on: each MR keeps its own cursor', async () => {
    const w = await world();
    const b = await w.publishSource('Add the second file', 'second');
    w.enable();
    const spawned: string[] = [];
    const counted: GitRunner = (file, args, options) => {
      spawned.push(String(args[args.indexOf('-C') + 2]));
      return runTool(file, args, options);
    };
    const poller = w.poller(counted);
    await poller.tick();
    // Два MR одного проекта — сервер репозитория читается раз за круг, не на каждый MR, и адрес
    // пуша — одним `git config` (pushurl и url вместе): круг из процессов git на MR дорожал с
    // каждой законченной задачей и не укладывался в бюджет проверки под нагрузкой.
    expect(spawned.filter((c) => c === 'remote')).toHaveLength(1);
    expect(spawned.filter((c) => c === 'config')).toHaveLength(1);
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'A: first' });
    expect((await poller.tick()).requested).toBe(1);
    const [answerA] = tasksBesides(w, [w.source.taskId, b.source.taskId]);
    // MR A удержан своей задачей ответов; заметка в него — и следом заметка в MR B.
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'A: while held' });
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: b.mrIid, body: 'B: please fix' });
    expect((await poller.tick()).requested).toBe(1);
    const [answerB] = tasksBesides(w, [w.source.taskId, b.source.taskId, answerA!]);
    expect(Object.values(w.registry.live(answerB!)!.state.units)[0]!.branch).toBe(b.branch);
    // Задача ответов A закончилась — её заметка, пришедшая за время ожидания, открывает задачу.
    w.registry
      .live(answerA!)!
      .append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    expect((await poller.tick()).requested).toBe(1);
    const [third] = tasksBesides(w, [w.source.taskId, b.source.taskId, answerA!, answerB!]);
    const next = w.registry.live(third!)!;
    expect(Object.values(next.state.units)[0]!.branch).toBe(w.branch);
    expect(linesOf(next, 'forge.event')).toEqual([
      expect.objectContaining({ mrIid: w.mrIid, author: 'reviewer' }),
    ]);
    // Состояние: у каждого MR своя отметка.
    const marks = JSON.parse(readFileSync(join(w.layout.root, FORGE_POLL_STATE), 'utf8')) as Record<
      string,
      { mrs: Record<string, number> }
    >;
    expect(Object.keys(Object.values(marks)[0]!.mrs).sort()).toEqual(
      [String(w.mrIid), String(b.mrIid)].sort(),
    );
  });

  it('a cancelled answer task is not a source: the next note is watched under the last done task', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    await poller.tick();
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'first' });
    expect((await poller.tick()).requested).toBe(1);
    const [answerId] = tasksBesides(w, [w.source.taskId]);
    w.registry
      .live(answerId!)!
      .append({ kind: 'task.ended', actor: 'core', data: { outcome: 'cancelled' } });
    await tick();
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'second' });
    expect((await poller.tick()).requested).toBe(1);
    const opened = w.notes.filter((n) => n.event === 'forge.poll.opened').map((n) => n.data);
    expect(opened.map((d) => d.fromTaskId)).toEqual([w.source.taskId, w.source.taskId]);
  });

  it('a local MR branch behind the server refuses: no task, the note comes back once the branch is fixed', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    await poller.tick();
    await tick();
    // Кто-то дописал ветку MR на сервере — локальная ветка отстала.
    const other = join(w.st.root, 'other');
    w.st.g(w.st.root, 'clone', '-q', '-b', w.branch, w.st.bare, other);
    w.st.commitIn(other, 'theirs.txt');
    w.st.g(other, 'push', '-q', 'origin', w.branch);
    w.stub.act('reviewer', { type: 'note', mrIid: w.mrIid, body: 'please fix' });
    const got = await poller.tick();
    expect(got.requested).toBe(0);
    expect(tasksBesides(w, [w.source.taskId])).toEqual([]);
    const refused = w.notes.filter((n) => String(n.data.message).includes('AnswerTaskRefused'));
    expect(refused).toHaveLength(1);
    expect(String(refused[0]!.data.message)).toMatch(/local branch is at/);
    // Человек убрал локальную ветку — следующий круг открывает задачу по той же заметке.
    w.st.g(w.st.main, 'branch', '-D', w.branch);
    expect((await poller.tick()).requested).toBe(1);
    const [answerId] = tasksBesides(w, [w.source.taskId]);
    const answer = w.registry.live(answerId!)!;
    expect(answer.state.created!.repos[0]!.baseRef).toBe(
      w.st.g(w.st.bare, 'rev-parse', `refs/heads/${w.branch}`),
    );
  });

  it('the answer task publishes its fix onto the same MR and its reply lands in the reviewer thread', async () => {
    const w = await world();
    w.enable();
    const poller = w.poller();
    await poller.tick();
    await tick();
    const thread = w.stub.act('reviewer', {
      type: 'note',
      mrIid: w.mrIid,
      body: 'please rename the file',
    }) as { id: string };
    expect((await poller.tick()).requested).toBe(1);
    const [answerId] = tasksBesides(w, [w.source.taskId]);
    const answer = w.registry.live(answerId!)!;
    // Человек правил заголовок и описание MR руками — задача ответов их не переписывает.
    w.stub.act('publisher', {
      type: 'mr-update',
      mrIid: w.mrIid,
      title: 'Feature file, edited by hand',
      body: 'Hand-written description.',
    });
    const before = w.st.g(w.st.bare, 'rev-parse', `refs/heads/${w.branch}`);
    // Копия — дорогой дирижёра (`createUnitCopy`) на существующей ветке MR, не руками.
    const got = await answerThroughPublish(w, answer, {
      file: 'feature.txt',
      text: 'renamed feature\n',
      replies: [{ threadId: thread.id, text: 'Renamed in the follow-up commit.', resolve: true }],
    });
    expect(got).toEqual({ published: { kind: 'published', mrIid: w.mrIid } });
    // Копия выложена на ветке MR с приколотой головы MR (её база — голова на сервере).
    const copyLine = linesOf(answer, 'action.started').find((a) => a.kind === 'copy-create')!;
    expect(String(copyLine.idempotencyHint)).toBe(`${w.branch}@${before}`);
    // Новый коммит поверх головы MR, в ту же ветку; второго MR нет.
    const after = w.st.g(w.st.bare, 'rev-parse', `refs/heads/${w.branch}`);
    expect(after).not.toBe(before);
    expect(w.st.g(w.st.bare, 'merge-base', '--is-ancestor', before, after)).toBe('');
    const snap = w.stub.state();
    expect(snap.mrs).toHaveLength(1);
    expect(linesOf(answer, 'action.started').map((a) => a.kind)).not.toContain('mr-create');
    // Ответ — в нити ревьюера, нить разрешена; заголовок MR задачи-источника не переписан.
    const d = snap.discussions.find((x) => x.id === thread.id)!;
    expect(d.notes.map((n) => n.body)).toContain('Renamed in the follow-up commit.');
    expect(d.resolved).toBe(true);
    expect(snap.mrs[0]).toMatchObject({
      title: 'Feature file, edited by hand',
      body: 'Hand-written description.',
    });
    expect(w.stub.requests.some((r) => r.forbidden)).toBe(false);
  });
});
