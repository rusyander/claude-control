import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardEntry } from '@agentdeck/contracts/core/board';
import { startStand, TOKENS, type Stand } from '../../api/__fixtures__/api-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import {
  fieldsDraft,
  startBoardStand,
  type BoardStand,
} from '../../bootstrap/__fixtures__/board-stand.ts';

/**
 * Доска через настоящий API ядра (этап 12, B1, B3; P152, P154, P156, P181, P183): записи и ходы
 * человека с судом полномочий, запускатель над настоящей оценкой и настоящим git-репозиторием,
 * пределы из настоящей настройки ядра. Подменены только ответы проб дорог.
 */

const stands: BoardStand[] = [];
let bare: Stand | undefined;
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
  await bare?.close();
  bare = undefined;
});

async function stand(opts: Parameters<typeof startBoardStand>[0] = {}): Promise<BoardStand> {
  const s = await startBoardStand(opts);
  stands.push(s);
  return s;
}

const entryOf = (entries: readonly BoardEntry[], id: string): BoardEntry => {
  const found = entries.find((e) => e.entryId === id);
  if (!found) throw new Error(`no entry ${id}`);
  return found;
};

function createdOf(b: BoardStand, taskId: string): Record<string, unknown> {
  const lines = readJournalLines(join(b.s.registry.tasksDir, taskId), taskId).lines;
  return lines.find((l) => l.kind === 'task.created')?.data as Record<string, unknown>;
}

describe('board API: human moves and entries (B1, P152, P181, P183)', () => {
  it('no board wiring → GET 501 and POST 501, never an empty board', async () => {
    bare = await startStand();
    expect((await bare.get('/v1/board')).status).toBe(501);
  });

  it('entries need a human: no proof 403, session token refused; honest proof → inbox cards; same cmdId replays, no duplicate', async () => {
    const b = await stand();
    // Пауза: в этом тесте очередь не должна стартовать сама.
    await b.setBoard({ paused: true });
    const draft = fieldsDraft(b.repo, 'Export button');
    const noProof = await b.post(
      '/v1/board/entries',
      { cmdId: newId(), to: 'inbox', entries: [draft] },
      { proof: false },
    );
    expect(noProof.status).toBe(403);
    expect(noProof.body.code).toBe('proof-required');
    const cmdId = newId();
    const made = await b.entries('inbox', [draft, fieldsDraft(b.repo, 'Second')], cmdId);
    expect(made.status).toBe(200);
    expect(made.body.replayed).toBe(false);
    expect(made.body.created).toHaveLength(2);
    const inbox = made.body.cards.filter((c) => c.column === 'inbox');
    expect(inbox.map((c) => c.title)).toEqual(['Export button', 'Second']);
    expect(inbox[0]!.moves).toEqual(['queue', 'work', 'rejected', 'inbox', 'set-preset', 'merge']);
    // Во входящих доказательства старта нет: старт разрешит только следующий ход человека.
    expect(entryOf(made.body.entries, made.body.created[0]!).proof).toBeUndefined();
    const again = await b.entries('inbox', [draft], cmdId);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.created).toEqual(made.body.created);
    expect(again.body.entries).toHaveLength(2);
  });

  it('a chat, group items mixed with other sources, an unknown preset and a link without the review preset are refused 422, nothing written', async () => {
    const b = await stand();
    await b.setBoard({ paused: true });
    const got = await b.entries('inbox', [
      fieldsDraft(b.repo, 'chat', { preset: 'chat' }),
      fieldsDraft(b.repo, 'mixed', {
        launch: {
          kind: 'fields',
          fields: {
            sources: [
              { kind: 'group-item', body: 'x' },
              { kind: 'text', body: 'y' },
            ],
          },
        },
      }),
      fieldsDraft(b.repo, 'nope', { preset: 'no-such-preset' }),
      fieldsDraft(b.repo, 'link', {
        launch: { kind: 'link', mrUrl: 'https://forge.example.com/g/p/-/merge_requests/1' },
      }),
    ]);
    expect(got.status).toBe(422);
    expect(got.body.code).toBe('entries-refused');
    const problems = (got.body as unknown as { problems: string[] }).problems;
    expect(problems).toHaveLength(4);
    expect(problems[1]).toMatch(/^entries\[1\]: sources: group items and other sources/);
    expect((await b.board()).entries).toEqual([]);
  });

  it('a library scenario is accepted by its id (the start resolves it like the estimate); a label that is not its scenario is refused', async () => {
    const b = await stand();
    await b.setBoard({ paused: true });
    const library = (title: string, preset: string) => {
      const draft = fieldsDraft(b.repo, title, { preset });
      const fields = (draft.launch as { fields: Record<string, unknown> }).fields;
      return {
        ...draft,
        launch: {
          kind: 'fields' as const,
          fields: { ...fields, scenario: { id: 'team-flow', version: 1 } },
        },
      };
    };
    const ok = await b.entries('inbox', [library('Library flow', 'team-flow')]);
    expect(ok.status).toBe(200);
    expect(ok.body.created).toHaveLength(1);
    const bad = await b.entries('inbox', [library('Mislabelled', 'other-flow')]);
    expect(bad.status).toBe(422);
    expect((bad.body as unknown as { problems: string[] }).problems).toEqual([
      'entries[0]: unknown preset other-flow',
    ]);
  });

  it('moves: inbox → queue stores the human proof of that move; "before" orders the queue; queue → inbox drops the proof', async () => {
    const b = await stand();
    await b.setBoard({ paused: true });
    const made = await b.entries('inbox', [
      fieldsDraft(b.repo, 'A'),
      fieldsDraft(b.repo, 'B'),
      fieldsDraft(b.repo, 'C'),
    ]);
    const [a, bb, c] = made.body.created as [string, string, string];
    const toQueue = newId();
    const q = await b.post<{ entries: BoardEntry[] }>('/v1/board/move', {
      cmdId: toQueue,
      entryId: a,
      to: 'queue',
    });
    expect(q.status).toBe(200);
    const proof = entryOf(q.body.entries, a).proof;
    expect(proof).toMatchObject({ kind: 'human', cmdId: toQueue });
    await b.move({ entryId: bb, to: 'queue' });
    // C — в очередь перед A: голова очереди теперь C.
    const ordered = await b.move({ entryId: c, to: 'queue', before: a });
    const queue = ordered.body.cards
      .filter((x) => x.column === 'queue')
      .sort((x, y) => (x.rank ?? 0) - (y.rank ?? 0))
      .map((x) => x.title);
    expect(queue).toEqual(['C', 'A', 'B']);
    const back = await b.move({ entryId: a, to: 'inbox' });
    expect(entryOf(back.body.entries, a).proof).toBeUndefined();
    expect(entryOf(back.body.entries, a).state).toBe('inbox');
  });

  it('a move outside the allowed list is 409 with the list; unknown card 404; a task card has no board moves', async () => {
    const b = await stand();
    await b.setBoard({ paused: true });
    const made = await b.entries('inbox', [fieldsDraft(b.repo, 'A')]);
    const id = made.body.created[0]!;
    const restore = await b.move({ entryId: id, to: 'restore' });
    expect(restore.status).toBe(409);
    expect(restore.body.code).toBe('move-not-allowed');
    expect(restore.body.allowed).toEqual([
      'queue',
      'work',
      'rejected',
      'inbox',
      'set-preset',
      'merge',
    ]);
    const rejected = await b.move({ entryId: id, to: 'rejected' });
    expect(rejected.status).toBe(200);
    // Отклонённая — без карточки, но запись цела: её можно вернуть.
    expect(rejected.body.cards.some((x) => x.id === id)).toBe(false);
    expect(entryOf(rejected.body.entries, id).state).toBe('rejected');
    const queueFromRejected = await b.move({ entryId: id, to: 'queue' });
    expect(queueFromRejected.status).toBe(409);
    expect(queueFromRejected.body.allowed).toEqual(['restore']);
    expect((await b.move({ entryId: id, to: 'restore' })).status).toBe(200);
    expect((await b.move({ entryId: newId(), to: 'queue' })).status).toBe(404);
    const task = await b.move({ taskId: b.s.taskId, to: 'queue' });
    expect(task.status).toBe(409);
    expect(task.body.allowed).toEqual([]);
  });

  it('the same move cmdId twice applies once (P181): the second answers replayed, the rank does not move again', async () => {
    const b = await stand();
    await b.setBoard({ paused: true });
    const made = await b.entries('inbox', [fieldsDraft(b.repo, 'A'), fieldsDraft(b.repo, 'B')]);
    const [a] = made.body.created as [string];
    const cmdId = newId();
    const first = await b.post<{ entries: BoardEntry[]; replayed: boolean }>('/v1/board/move', {
      cmdId,
      entryId: a,
      to: 'inbox',
    });
    const rank = entryOf(first.body.entries, a).rank;
    const second = await b.post<{ entries: BoardEntry[]; replayed: boolean }>('/v1/board/move', {
      cmdId,
      entryId: a,
      to: 'inbox',
    });
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(entryOf(second.body.entries, a).rank).toBe(rank);
  });

  it('W2-D set-preset (P164): an inbox entry changes preset in place; a missing prerequisite is named; once started it is refused; the session token is forged', async () => {
    const b = await stand();
    await b.setBoard({ paused: true });
    const made = await b.entries('inbox', [fieldsDraft(b.repo, 'A'), fieldsDraft(b.repo, 'B')]);
    const [a, bb] = made.body.created as [string, string];
    const before = entryOf(made.body.entries, a);
    const changed = await b.move({ entryId: a, to: 'set-preset', preset: 'bug-fix' });
    expect(changed.status).toBe(200);
    const after = entryOf(changed.body.entries, a);
    expect(after).toMatchObject({ preset: 'bug-fix', state: 'inbox', rank: before.rank });
    expect(after.proof).toBeUndefined();
    // Предпосылка не выполнена — отказ называет её; запись не тронута.
    const ticket = await b.move({ entryId: a, to: 'set-preset', preset: 'tracker-ticket' });
    expect([ticket.status, ticket.body.code]).toEqual([409, 'move-not-allowed']);
    expect((ticket.body as unknown as { reason: string }).reason).toBe(
      'preset tracker-ticket: the tracker-ticket preset needs a tracker snapshot in the launch source (kind tracker)',
    );
    const link = await b.move({ entryId: a, to: 'set-preset', preset: 'review-link' });
    expect((link.body as unknown as { reason: string }).reason).toBe(
      'preset review-link: the review-link preset starts from a link launch',
    );
    for (const preset of ['chat', 'answer-reviewers', 'ask', 'no-such-preset'])
      expect((await b.move({ entryId: a, to: 'set-preset', preset })).status).toBe(409);
    expect(entryOf((await b.board()).entries, a).preset).toBe('bug-fix');
    // `preset` без хода `set-preset` и ход без `preset` — не разбираются.
    expect((await b.move({ entryId: a, to: 'set-preset' })).status).toBe(400);
    expect((await b.move({ entryId: a, to: 'queue', preset: 'feature' })).status).toBe(400);
    // Токен сессии модели — не человек: суд полномочий отказывает, пресет прежний.
    const forged = await b.post(
      '/v1/board/move',
      { cmdId: newId(), entryId: a, to: 'set-preset', preset: 'refactor' },
      { token: TOKENS.session },
    );
    expect([forged.status, forged.body.code]).toEqual([403, 'forged-authority']);
    expect(entryOf((await b.board()).entries, a).preset).toBe('bug-fix');
    // В очереди — новое слово человека становится доказательством старта.
    await b.move({ entryId: bb, to: 'queue' });
    const cmdId = newId();
    const queued = await b.post<{ entries: BoardEntry[] }>('/v1/board/move', {
      cmdId,
      entryId: bb,
      to: 'set-preset',
      preset: 'refactor',
    });
    expect(entryOf(queued.body.entries, bb)).toMatchObject({
      preset: 'refactor',
      state: 'queued',
      proof: { kind: 'human', cmdId },
    });
    // Старт начат — пресет больше не меняется (дальше ведёт журнал задачи).
    await b.setBoard({ paused: false });
    await b.settle();
    const started = entryOf((await b.board()).entries, bb);
    expect(started.state).toBe('started');
    expect(createdOf(b, started.taskId!).scenario).toMatchObject({ id: 'refactor' });
    const late = await b.move({ entryId: bb, to: 'set-preset', preset: 'feature' });
    expect([late.status, late.body.allowed]).toEqual([409, []]);
  });

  it('an invalid board section: the board serves the defaults and names the config issue; a valid write clears it', async () => {
    const b = await stand();
    // Порт настройки принимает запись с негодным разделом и служит умолчаниями — доска обязана это сказать.
    await b.setBoard({ inWork: 5 as never });
    const bad = await b.board();
    expect(bad.limits.inWork.cap).toBe(2);
    expect(bad.configIssues).toEqual([
      { section: 'board', reason: expect.stringContaining('inWork') },
    ]);
    await b.setBoard({ inWork: 1 });
    const good = await b.board();
    expect(good.limits.inWork.cap).toBe(1);
    expect(good.configIssues).toBeUndefined();
  });
});

describe('board launcher (B3, P154, P155, P156)', () => {
  it('cap 1: the head starts through the real estimate with boardEntry; the next waits until the first ends', async () => {
    const b = await stand();
    await b.setBoard({ inWork: 1 });
    const cmdId = newId();
    const made = await b.entries(
      'queue',
      [fieldsDraft(b.repo, 'First'), fieldsDraft(b.repo, 'Second')],
      cmdId,
    );
    const [first, second] = made.body.created as [string, string];
    await b.settle();
    let board = await b.board();
    const one = entryOf(board.entries, first);
    expect(one.state).toBe('started');
    expect(entryOf(board.entries, second).state).toBe('queued');
    expect(board.limits.inWork).toEqual({ used: 1, cap: 1 });
    const created = createdOf(b, one.taskId!);
    expect(created.boardEntry).toEqual({
      entryId: first,
      stop: 'mr',
      source: 'manual',
      proof: { kind: 'human', cmdId },
    });
    // Тот же путь, что у человека: ключ повтора оценки — `cmdId` записи.
    expect(created.origin).toEqual({ cmdId: one.cmdId });
    expect(created.launchPolicy).toBe('auto');
    const card = board.cards.find((x) => x.taskId === one.taskId)!;
    expect(card).toMatchObject({ kind: 'task', entryId: first, column: 'triage', moves: [] });
    // Первая кончилась настоящей отменой — место свободно, вторая стартует по журналу.
    const cancel = await b.s.command({
      cmdId: newId(),
      kind: 'cancel',
      target: { taskId: one.taskId },
      fields: { reason: 'done with it' },
      proof: await b.s.nonce(),
    });
    expect(cancel.status).toBe(200);
    await b.settle();
    board = await b.board();
    const two = entryOf(board.entries, second);
    expect(two.state).toBe('started');
    const endedAt = readJournalLines(
      join(b.s.registry.tasksDir, one.taskId!),
      one.taskId!,
    ).lines.find((l) => l.kind === 'task.ended')!.at;
    const secondCreatedAt = readJournalLines(
      join(b.s.registry.tasksDir, two.taskId!),
      two.taskId!,
    ).lines.find((l) => l.kind === 'task.created')!.at;
    expect(secondCreatedAt).toBeGreaterThanOrEqual(endedAt);
  });

  it('pause starts nothing; stop "plan" launches with confirm (the task stops after its estimate)', async () => {
    const b = await stand();
    await b.setBoard({ paused: true, inWork: 2 });
    const made = await b.entries('queue', [fieldsDraft(b.repo, 'Plan only', { stop: 'plan' })]);
    await b.settle();
    expect(entryOf((await b.board()).entries, made.body.created[0]!).state).toBe('queued');
    await b.setBoard({ paused: false });
    await b.settle();
    const e = entryOf((await b.board()).entries, made.body.created[0]!);
    expect(e.state).toBe('started');
    const created = createdOf(b, e.taskId!);
    expect(created.launchPolicy).toBe('confirm');
    expect(created.boardEntry).toMatchObject({ stop: 'plan' });
  });

  it('a group is ONE entry: its start fans out a task per item under one groupId, every card names the entry', async () => {
    const b = await stand();
    await b.setBoard({ paused: true, inWork: 4 });
    const items = ['One', 'Two', 'Three'].map((title, i) => ({
      kind: 'group-item' as const,
      key: `item-${i + 1}`,
      title,
      body: `Do ${title}.`,
      fetchedAt: 1,
      digest: createHash('sha256').update(`Do ${title}.`).digest('hex'),
    }));
    // Снимок источника читает только приём ведущего — группа идёт сценарием `lead`, как с формы.
    const draft = fieldsDraft(b.repo, 'Group of three', { stop: 'plan', preset: 'lead' });
    const fields = (draft.launch as { fields: Record<string, unknown> }).fields;
    const made = await b.entries('queue', [
      { ...draft, launch: { kind: 'fields', fields: { ...fields, sources: items } } },
    ]);
    expect(made.status).toBe(200);
    expect(made.body.created).toHaveLength(1);
    const entryId = made.body.created[0]!;
    await b.setBoard({ paused: false });
    await b.settle();
    const board = await b.board();
    const entry = entryOf(board.entries, entryId);
    expect({ state: entry.state, reason: entry.reason }).toEqual({ state: 'started' });
    // Стенд держит свою задачу без группы: она не задача записи и не должна получить её карточку.
    const tasks = board.cards.filter((c) => c.kind === 'task');
    const cards = tasks.filter((c) => c.groupId !== undefined);
    expect(tasks.filter((c) => c.groupId === undefined).every((c) => !c.entryId)).toBe(true);
    expect(cards.map((c) => c.title).sort()).toEqual(['One', 'Three', 'Two']);
    const groupIds = new Set(cards.map((c) => c.groupId));
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).toMatch(/^group-/);
    // Каждая задача группы несёт запись доски: карточка называет её, а не теряет после первой.
    expect(cards.every((c) => c.entryId === entryId)).toBe(true);
    expect(cards.map((c) => c.taskId)).toContain(entry.taskId);
    for (const c of cards) {
      const created = createdOf(b, c.taskId!);
      expect(created.boardEntry).toMatchObject({ entryId, stop: 'plan' });
      expect(created.launchPolicy).toBe('confirm');
    }
    // Записи-карточки больше нет: запись рисуют её задачи.
    expect(board.cards.some((c) => c.kind === 'entry' && c.entryId === entryId)).toBe(false);
  });

  it('a refused estimate (no repo) returns the entry to the inbox with the reason; the slot and the day are not spent', async () => {
    const b = await stand();
    await b.setBoard({ inWork: 1, perDay: 1 });
    const bad = fieldsDraft(join(b.root, 'not-a-repo'), 'Broken');
    const made = await b.entries('queue', [bad, fieldsDraft(b.repo, 'Good')]);
    const [broken, good] = made.body.created as [string, string];
    await b.settle();
    const board = await b.board();
    const back = entryOf(board.entries, broken);
    expect(back.state).toBe('inbox');
    expect(back.reason).toBeTruthy();
    expect(back.proof).toBeUndefined();
    expect(back.startedAt).toBeUndefined();
    // Сутки не потрачены отказом: следующая запись стартовала при пределе 1 в сутки.
    expect(entryOf(board.entries, good).state).toBe('started');
    expect(board.limits.perDay).toEqual({ used: 1, cap: 1 });
  });

  it('the head route held by its window starts nothing and carries the reason; the window reset starts it', async () => {
    const b = await stand();
    b.env.allowedRoutes = () => ({
      routes: [{ adapter: 'a-1', route: { kind: 'stub', id: 'r-held' }, modelPattern: '*' }],
      level: 2,
    });
    const now = Date.now();
    b.s.windows.observe({
      routeId: 'r-held',
      limitKind: 'window',
      usedPct: 100,
      resetAt: now + 3_600_000,
      refusal: true,
      source: 'refusal',
      at: now,
    });
    const made = await b.entries('queue', [fieldsDraft(b.repo, 'Held')]);
    await b.settle();
    const held = entryOf((await b.board()).entries, made.body.created[0]!);
    expect(held.state).toBe('queued');
    expect(held.reason).toMatch(/window/);
    b.s.windows.observe({
      routeId: 'r-held',
      limitKind: 'window',
      usedPct: 10,
      resetAt: null,
      refusal: false,
      source: 'cli-event',
      at: now + 1,
    });
    await b.settle();
    expect(entryOf((await b.board()).entries, made.body.created[0]!).state).toBe('started');
  });
});
