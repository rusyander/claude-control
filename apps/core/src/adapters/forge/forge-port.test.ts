import type { ForgeKind, ForgePort } from '@agentdeck/contracts/core/forge';
import { mrBodyHash as stubBodyHash, startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVITY_MAX_PAGES } from './activity.ts';
import { createForgePort, mrBodyHash, noteHash } from './index.ts';

/**
 * Каждый метод ForgePort на обоих видах против заглушки форжа (настоящий HTTP на loopback):
 * формы ответов разбираются тем же кодом, что пойдёт к настоящему серверу (R4 — живой форж
 * только по слову владельца).
 */

let stub: StubForge | undefined;
afterEach(async () => {
  await stub?.stop();
  stub = undefined;
});

async function portOn(
  kind: Exclude<ForgeKind, 'generic'>,
  options: Parameters<typeof startStubForge>[0] = {},
  as = 'publisher',
): Promise<{ port: ForgePort; s: StubForge }> {
  const s = await startStubForge(options);
  stub = s;
  const port = createForgePort({
    project: { kind, ref: 'acme/app', baseUrl: s.url, pushUrl: `${s.url}/acme/app.git` },
    token: s.tokens[as]!,
    fetch: globalThis.fetch,
    timeoutMs: 2_000,
  });
  return { port, s };
}

const value = <T>(fact: { value: T } | { absent: true } | { unknown: string }): T => {
  if (!('value' in fact)) throw new Error(`expected value, got ${JSON.stringify(fact)}`);
  return fact.value;
};

describe.each(['gitlab', 'github'] as const)('forge port %s against the stub forge', (kind) => {
  it('whoAmI names the account of the access value', async () => {
    const { port } = await portOn(kind);
    expect(value(await port.whoAmI())).toEqual({ id: '1', username: 'publisher' });
  });

  it('createMr → mrBySourceBranch finds it only by own account and created ≥ start', async () => {
    let now = 1_700_000_000_000;
    const { port, s } = await portOn(kind, { now: () => now });
    const startedAt = now;
    now += 1_000;
    const created = await port.createMr({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      title: 'Add x',
      body: 'Why x.',
      draft: true,
    });
    if (!('value' in created)) throw new Error(JSON.stringify(created));
    const mr = created.value;
    expect(mr).toMatchObject({ iid: 1, draft: true, author: 'publisher' });
    expect(mr.bodyHash).toBe(mrBodyHash('Add x', 'Why x.'));
    expect(mr.bodyHash).toBe(stubBodyHash('Add x', 'Why x.'));
    const found = await port.mrBySourceBranch({
      sourceBranch: 'feat/x',
      createdAfter: startedAt,
      author: 'publisher',
    });
    expect(value(found).iid).toBe(1);
    expect(
      await port.mrBySourceBranch({
        sourceBranch: 'feat/x',
        createdAfter: startedAt,
        author: 'reviewer',
      }),
    ).toEqual({
      absent: true,
    });
    expect(
      await port.mrBySourceBranch({
        sourceBranch: 'feat/x',
        createdAfter: now + 1,
        author: 'publisher',
      }),
    ).toEqual({
      absent: true,
    });
    expect(
      await port.mrBySourceBranch({
        sourceBranch: 'other',
        createdAfter: startedAt,
        author: 'publisher',
      }),
    ).toEqual({
      absent: true,
    });
    // Чужой MR на той же ветке после старта — не наш: сверка его не примет за свой.
    s.act('reviewer', {
      type: 'mr-open',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      title: 'Theirs',
    });
    expect(
      value(
        await port.mrBySourceBranch({
          sourceBranch: 'feat/x',
          createdAfter: startedAt,
          author: 'publisher',
        }),
      ).iid,
    ).toBe(1);
  });

  it('mr by id: value, 404 → absent; updateMr keeps draft and moves the body hash', async () => {
    const { port } = await portOn(kind);
    await port.createMr({
      sourceBranch: 'a',
      targetBranch: 'main',
      title: 'T',
      body: 'B',
      draft: true,
    });
    expect(value(await port.mr(1)).sourceBranch).toBe('a');
    expect(await port.mr(99)).toEqual({ absent: true });
    const updated = await port.updateMr(1, { title: 'T2', body: 'B2' });
    expect('value' in updated && updated.value).toMatchObject({
      draft: true,
      bodyHash: mrBodyHash('T2', 'B2'),
    });
    expect(value(await port.mr(1)).bodyHash).toBe(mrBodyHash('T2', 'B2'));
  });

  it('threads read, reply and resolve on review-threads-unseen', async () => {
    const { port } = await portOn(kind, { scenario: 'review-threads-unseen' });
    await port.createMr({
      sourceBranch: 'a',
      targetBranch: 'main',
      title: 'T',
      body: 'B',
      draft: false,
    });
    const threads = value(await port.threads(1));
    expect(threads).toHaveLength(2);
    expect(
      threads.every((t) => t.resolvable && !t.resolved && t.notes[0]!.author === 'reviewer'),
    ).toBe(true);
    const note = await port.reply(1, threads[0]!.id, 'Renamed in the next commit.');
    expect('value' in note && note.value).toMatchObject({
      author: 'publisher',
      bodyHash: noteHash('Renamed in the next commit.'),
    });
    expect(await port.resolve(1, threads[0]!.id)).toEqual({ value: true });
    const after = value(await port.threads(1));
    expect(after[0]).toMatchObject({ resolved: true });
    expect(after[0]!.notes.map((n) => n.author)).toEqual(['reviewer', 'publisher']);
    expect(after[1]).toMatchObject({ resolved: false });
    const bad = await port.reply(1, 'no-such-thread', 'x');
    expect('unknown' in bad).toBe(true);
  });

  it('mergeability: clean, conflict, checking; absent MR → absent', async () => {
    const { port, s } = await portOn(kind);
    await port.createMr({
      sourceBranch: 'a',
      targetBranch: 'main',
      title: 'T',
      body: '',
      draft: false,
    });
    expect(await port.mergeability(1)).toEqual({ value: 'clean' });
    s.act('reviewer', { type: 'mergeability', mrIid: 1, conflict: true });
    expect(await port.mergeability(1)).toEqual({ value: 'conflict' });
    s.act('reviewer', { type: 'mergeability', mrIid: 1, checking: true });
    expect(await port.mergeability(1)).toEqual({ value: 'checking' });
    expect(await port.mergeability(7)).toEqual({ absent: true });
  });

  it('pipelines of the head sha with jobs; infra job has no started script; log tail', async () => {
    const { port, s } = await portOn(kind, { scenario: 'mr-red-never-settles-green' });
    const sha = 'b'.repeat(40);
    s.act('publisher', {
      type: 'mr-open',
      sourceBranch: 'a',
      targetBranch: 'main',
      title: 'T',
      headSha: sha,
    });
    const pipelines = value(await port.pipelines({ sha }));
    expect(pipelines.map((p) => p.status).sort()).toEqual(['failed', 'success']);
    const red = pipelines.find((p) => p.status === 'failed')!;
    expect(red.jobs[0]).toMatchObject({ status: 'failed', scriptStarted: false });
    const green = pipelines.find((p) => p.status === 'success')!;
    expect(green.createdAt).toBeGreaterThan(red.createdAt);
    const log = value(await port.jobLogTail(green.jobs[0]!.id, 40));
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(40);
    expect(value(await port.pipelines({ sha: 'c'.repeat(40) }))).toEqual([]);
    expect(await port.jobLogTail('424242', 100)).toEqual({ absent: true });
  });

  it('activitySince names the author of every event on the asked refs and MRs', async () => {
    let now = 1_700_000_000_000;
    const { port, s } = await portOn(kind, { now: () => now });
    const since = now;
    now += 10;
    await port.createMr({
      sourceBranch: 'feat',
      targetBranch: 'main',
      title: 'T',
      body: '',
      draft: false,
    });
    now += 10;
    s.act('reviewer', { type: 'note', mrIid: 1, body: 'hm' });
    s.act('reviewer', { type: 'push', ref: 'feat', sha: 'd'.repeat(40) });
    s.act('reviewer', { type: 'push', ref: 'unrelated', sha: 'e'.repeat(40) });
    s.act('reviewer', { type: 'approval', mrIid: 1 });
    const got = value(await port.activitySince({ since, refs: ['feat'], mrIids: [1] }));
    expect(got.map((a) => [a.type, a.author])).toEqual([
      ['mr-open', 'publisher'],
      ['note', 'reviewer'],
      ['push', 'reviewer'],
      ['approval', 'reviewer'],
    ]);
    expect(
      value(await port.activitySince({ since: now + 1, refs: ['feat'], mrIids: [1] })),
    ).toEqual([]);
  });

  it('activitySince pages back to `since`: a note older than the newest page is still returned', async () => {
    let now = 1_700_000_000_000;
    const { port, s } = await portOn(kind, { now: () => now });
    await port.createMr({
      sourceBranch: 'feat',
      targetBranch: 'main',
      title: 'T',
      body: '',
      draft: false,
    });
    const since = (now += 10);
    s.act('reviewer', { type: 'note', mrIid: 1, body: 'the oldest note of the window' });
    // 150 событий новее заметки: первая страница ленты (100) её не содержит.
    for (let i = 0; i < 150; i += 1) {
      now += 1;
      s.act('reviewer', { type: 'push', ref: 'busy', sha: 'f'.repeat(40) });
    }
    const got = value(await port.activitySince({ since, refs: [], mrIids: [1] }));
    expect(got.map((a) => [a.type, a.author])).toEqual([['note', 'reviewer']]);
  });

  it('activitySince never cuts the window silently: past the page cap it is unknown', async () => {
    let now = 1_700_000_000_000;
    const { port, s } = await portOn(kind, { now: () => now });
    const since = now;
    // Больше событий в окне, чем отдаёт потолок страниц переходника (GitHub — 300 в ленте).
    const over = kind === 'github' ? 320 : ACTIVITY_MAX_PAGES.gitlab * 100 + 20;
    for (let i = 0; i < over; i += 1) {
      now += 1;
      s.act('reviewer', { type: 'push', ref: 'busy', sha: 'f'.repeat(40) });
    }
    const got = await port.activitySince({ since, refs: ['busy'], mrIids: [] });
    expect(got).toEqual({ unknown: expect.stringMatching(/older than|page cap|window/) });
  });
});
