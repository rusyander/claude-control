import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEW_THREAD_BODIES } from '@agentdeck/stub-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { presetOf } from '../../conductor/scenario/index.ts';
import { SOLO_UNIT } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { REAL_PUBLISH_TIMEOUT_MS } from '../guard-wiring/__fixtures__/guard-stand.ts';
import {
  closePublishStands,
  composed,
  publishStand as stand,
} from './__fixtures__/publish-stand.ts';

/** Стенд — `__fixtures__/publish-stand.ts` (общий с пробой сдачи). */

afterEach(closePublishStands);

const SCENARIO = { id: 'feature', version: 1 } as const;

const OK = { verdict: { ok: true as const }, compositionId: null as string | null };

describe('publish wiring', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('composes the gated worktree, pushes, takes the MR id from the forge, reads threads once', async () => {
    const one = await stand('review-threads-unseen');
    const compositionId = await composed(one);
    expect(one.lines('publish.composed')).toEqual([
      expect.objectContaining({ compositionId, shape: 'kept', commits: [expect.any(String)] }),
    ]);
    const head = one.st.g(one.st.copy, 'rev-parse', 'HEAD');
    const got = await one.wiring.hooks.onPublish!(one.s, compositionId);
    expect(got).toEqual({ kind: 'published', mrIid: expect.any(Number) });
    expect(one.st.g(one.st.bare, 'rev-parse', `refs/heads/${one.st.branch}`)).toBe(head);
    const mr = one.lines('publish.mr');
    expect(mr).toEqual([expect.objectContaining({ mrIid: (got as { mrIid: number }).mrIid })]);
    const read = one.lines('publish.read');
    expect(read).toHaveLength(1);
    expect((read[0]!.threads as unknown[]).length).toBe(2);
    // Повтор: ни второго пуша, ни второго MR, ни второго чтения нитей.
    const again = await one.wiring.hooks.onPublish!(one.s, compositionId);
    expect(again).toEqual(got);
    const started = one.lines('action.started').map((d) => d.kind);
    expect(started.filter((k) => k === 'push')).toHaveLength(1);
    expect(started.filter((k) => k === 'mr-create')).toHaveLength(1);
    expect(one.lines('publish.read')).toHaveLength(1);
    expect(one.stub.requests.some((r) => r.forbidden)).toBe(false);
  });

  it('the answer-reviewers step gets a threads section with every open reviewer note; other steps get none', async () => {
    const one = await stand('review-threads-unseen');
    const compositionId = await composed(one);
    await one.wiring.hooks.onPublish!(one.s, compositionId);
    const answer = presetOf(SCENARIO)!.steps.find((s) => s.kind === 'answer-reviewers')!;
    const got = await one.wiring.hooks.preStep!({ ...one.s, stepId: newId(), def: answer });
    expect(got.verdict).toEqual({ ok: true });
    expect(got.sections.map((x) => x.id)).toEqual(['threads']);
    for (const body of REVIEW_THREAD_BODIES) expect(got.sections[0]!.text).toContain(body);
    expect(got.sections[0]!.text).toContain('reviewer: ');
    const other = await one.wiring.hooks.preStep!(one.s);
    expect(other.sections).toEqual([]);
  });

  it('threads unreadable at the forge: the section names the reason instead of an empty brief', async () => {
    const one = await stand('review-threads-unseen');
    const compositionId = await composed(one);
    await one.wiring.hooks.onPublish!(one.s, compositionId);
    one.stub.fault({ kind: 'status', status: 502, path: '/discussions' });
    const answer = presetOf(SCENARIO)!.steps.find((s) => s.kind === 'answer-reviewers')!;
    const got = await one.wiring.hooks.preStep!({ ...one.s, stepId: newId(), def: answer });
    expect(got.sections).toEqual([
      expect.objectContaining({ id: 'threads', text: expect.stringMatching(/could not be read/) }),
    ]);
  });

  it('a commit after the composition refuses with regate: the tree is compared, not trusted', async () => {
    const one = await stand();
    const compositionId = await composed(one);
    one.st.commitIn(one.st.copy, 'late.txt');
    expect(await one.wiring.hooks.onPublish!(one.s, compositionId)).toMatchObject({
      kind: 'refused',
      next: 'regate',
    });
    expect(one.lines('action.started')).toEqual([]);
  });

  it('the base moved with a conflict before the MR: rebase stops, refused resolve-conflict, nothing pushed', async () => {
    const one = await stand();
    writeFileSync(join(one.st.copy, 'a.txt'), 'mine\n');
    const compositionId = newId();
    await one.wiring.hooks.onFinalGate!(one.u, { ...OK, compositionId });
    const mine = one.st.g(one.st.copy, 'rev-parse', 'HEAD');
    writeFileSync(join(one.st.main, 'a.txt'), 'server\n');
    one.st.g(one.st.main, 'commit', '-qam', 'server change');
    one.st.g(one.st.main, 'push', '-q', 'origin', 'main');
    expect(await one.wiring.hooks.onPublish!(one.s, compositionId)).toMatchObject({
      kind: 'refused',
      next: 'resolve-conflict',
    });
    expect(one.st.g(one.st.copy, 'rev-parse', 'HEAD')).toBe(mine);
    expect(
      one.st.run(one.st.bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${one.st.branch}`])
        .status,
    ).not.toBe(0);
  });

  it('a forge outage waits with a backoff line on EVERY attempt, the count growing per unit', async () => {
    const one = await stand();
    const compositionId = await composed(one);
    // Соседняя единица ждёт форж уже четвёртый раз — ПОСЛЕ сборки этой: её счёт сюда не достаётся.
    const other = newId();
    one.task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId: other,
      data: {
        unitId: other,
        repoKey: 'r1',
        branch: 'agentdeck/other',
        ownedPaths: [],
        ...SOLO_UNIT,
      },
    });
    one.task.append({
      kind: 'publish.backoff',
      actor: 'core',
      unitId: other,
      data: { unitId: other, attempt: 4, waitMs: 600_000, cause: 'earlier outage' },
    });
    one.stub.fault({ kind: 'status', status: 503 });
    for (let i = 0; i < 2; i += 1)
      expect(await one.wiring.hooks.onPublish!(one.s, compositionId)).toMatchObject({
        kind: 'refused',
        next: 'wait-forge',
      });
    const mine = one.lines('publish.backoff').filter((b) => b.unitId === one.u.unitId);
    expect(mine.map((b) => b.attempt)).toEqual([1, 2]);
    expect(one.lines('publish.mr')).toEqual([]);
  });

  it('CI on a live ciWait: a red script goes to the fix step once per head sha; the latest pipeline decides', async () => {
    const red = await stand('ci-code-red', true);
    const redComp = await composed(red);
    expect(await red.wiring.hooks.onPublish!(red.s, redComp)).toMatchObject({
      kind: 'refused',
      next: 'fix-step',
    });
    expect(red.lines('publish.ci')).toEqual([expect.objectContaining({ class: 'code' })]);
    // Тот же красный sha второй раз шагу правки не отдаётся.
    expect(await red.wiring.hooks.onPublish!(red.s, redComp)).toMatchObject({ kind: 'published' });

    const settled = await stand('mr-red-never-settles-green', true);
    const settledComp = await composed(settled);
    expect(await settled.wiring.hooks.onPublish!(settled.s, settledComp)).toMatchObject({
      kind: 'published',
    });
    expect(settled.lines('publish.ci')).toEqual([expect.objectContaining({ class: 'green' })]);
  });

  it('without a live ciWait the pipelines are never read, a red CI does not hold the MR', async () => {
    const one = await stand('ci-code-red', false);
    const compositionId = await composed(one);
    expect(await one.wiring.hooks.onPublish!(one.s, compositionId)).toMatchObject({
      kind: 'published',
    });
    expect(one.lines('publish.ci')).toEqual([]);
    expect(one.stub.requests.some((r) => /pipelines/.test(r.path))).toBe(false);
  });

  it('clean-remote deletes exactly the listed refs and confirms by reading the server', async () => {
    const one = await stand();
    one.st.g(one.st.main, 'push', '-q', 'origin', `main:refs/heads/${one.st.branch}`);
    one.st.g(one.st.main, 'push', '-q', 'origin', 'main:refs/heads/keep-me');
    // Хвост имени совпадает с названной веткой: `ls-remote` его находит, удалять его нельзя.
    one.st.g(one.st.main, 'push', '-q', 'origin', `main:refs/tags/x/refs/heads/${one.st.branch}`);
    const got = await one.wiring.commands.cleanRemote(one.task, {
      refs: [`refs/heads/${one.st.branch}`, 'refs/heads/never-there'],
      remote: null,
    });
    expect(got).toEqual({
      deleted: [`refs/heads/${one.st.branch}`],
      absent: ['refs/heads/never-there'],
      failed: [],
    });
    const left = one.st.g(one.st.bare, 'for-each-ref', '--format=%(refname)');
    expect(left).toContain('refs/heads/keep-me');
    expect(left).toContain('refs/heads/main');
    expect(left).toContain(`refs/tags/x/refs/heads/${one.st.branch}`);
    expect(left.split('\n')).not.toContain(`refs/heads/${one.st.branch}`);
    expect(one.lines('action.started').map((d) => d.kind)).toEqual(['ref-delete']);
  });
});
