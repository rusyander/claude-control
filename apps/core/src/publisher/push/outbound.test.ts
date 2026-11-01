import type { ForgeMr, ForgePort, ForgeThread } from '@agentdeck/contracts/core/forge';
import { describe, expect, it } from 'vitest';
import { noteHash } from '../../adapters/forge/index.ts';
import type { PushMode } from '../../platform/git/push.ts';
import { readOnce, sendReplies, wantsCi } from '../after/after.ts';
import { buildMrDescription } from '../mr/description.ts';
import { ensureMr, syncMrBody } from '../mr/mr.ts';
import { pushModeOf, pushUnit } from './push.ts';
import type { OutboxPort } from './push.types.ts';

/**
 * Исходящее публикатора (05 §Push and MR, §After publish) на поддельном форже и outbox в памяти:
 * аренда до MR и перемотка после, личность MR только из ответа форжа, нити читаются при открытии,
 * CI — только по живому решению.
 */

function memOutbox(): OutboxPort & { calls: { kind: string; target: string; hint: string }[] } {
  const calls: { kind: string; target: string; hint: string }[] = [];
  let n = 0;
  return {
    calls,
    async run(spec, effect) {
      calls.push({ kind: spec.kind, target: spec.target, hint: spec.idempotencyHint });
      n += 1;
      const got = await effect();
      return got.ok
        ? { ok: true, actionId: `a${n}`, result: got.result }
        : { ok: false, actionId: `a${n}`, code: got.code };
    },
  };
}

const mr = (over: Partial<ForgeMr> = {}): ForgeMr =>
  ({
    id: 'g-7',
    iid: 7,
    url: 'https://tracker.example.com/r/-/merge_requests/7',
    sourceBranch: 'agentdeck/u1',
    targetBranch: 'main',
    state: 'opened',
    headSha: 'h',
    bodyHash: 'x',
    author: 'bot',
    createdAt: 0,
    ...over,
  }) as ForgeMr;

function fakeForge(over: Partial<ForgePort> = {}): ForgePort & { log: string[] } {
  const log: string[] = [];
  const base = {
    log,
    createMr: async () => {
      log.push('createMr');
      return { value: mr() };
    },
    mrBySourceBranch: async () => {
      log.push('mrBySourceBranch');
      return { absent: true as const };
    },
    mr: async () => ({ value: mr() }),
    updateMr: async () => {
      log.push('updateMr');
      return { value: mr() };
    },
    threads: async () => {
      log.push('threads');
      return { value: [] as ForgeThread[] };
    },
    mergeability: async () => ({ value: 'clean' as const }),
    reply: async () => {
      log.push('reply');
      return { value: { id: 'n', author: 'bot', body: '', bodyHash: '', createdAt: 0 } };
    },
    resolve: async () => {
      log.push('resolve');
      return { value: true as const };
    },
    pipelines: async () => {
      log.push('pipelines');
      return { value: [] };
    },
  };
  return { ...base, ...over } as unknown as ForgePort & { log: string[] };
}

describe('publisher push', () => {
  it('before the MR the push leases on the server sha; after the MR it is fast-forward only', () => {
    expect(pushModeOf({ before: 'S', mrExists: false })).toEqual({ kind: 'lease', expect: 'S' });
    expect(pushModeOf({ before: null, mrExists: false })).toEqual({ kind: 'lease', expect: null });
    expect(pushModeOf({ before: 'S', mrExists: true })).toEqual({ kind: 'fast-forward' });
  });

  it('pushes through the outbox with the forge action key; the server already holding the sha pushes nothing', async () => {
    const outbox = memOutbox();
    const modes: PushMode[] = [];
    const push = async (m: PushMode) => {
      modes.push(m);
      return { kind: 'pushed' as const };
    };
    const input = {
      url: 'https://tracker.example.com/r.git',
      branch: 'b',
      sha: 'S2',
      before: 'S1',
      mrExists: false,
    };
    expect(await pushUnit({ outbox, push }, input)).toEqual({ kind: 'pushed', actionId: 'a1' });
    expect(outbox.calls[0]).toMatchObject({ kind: 'push', target: `${input.url} refs/heads/b` });
    expect(modes).toEqual([{ kind: 'lease', expect: 'S1' }]);
    expect(await pushUnit({ outbox, push }, { ...input, before: 'S2' })).toEqual({
      kind: 'already',
    });
    expect(outbox.calls).toHaveLength(1);
  });

  it('a server refusal is reported as rejected with its detail', async () => {
    const push = async () => ({ kind: 'rejected' as const, detail: 'stale info' });
    const got = await pushUnit(
      { outbox: memOutbox(), push },
      { url: 'u', branch: 'b', sha: 'S', before: null, mrExists: true },
    );
    expect(got).toEqual({ kind: 'rejected', detail: 'stale info' });
  });
});

describe('publisher mr', () => {
  const input = {
    unitId: 'u1',
    url: 'https://tracker.example.com/r.git',
    sourceBranch: 'agentdeck/u1',
    targetBranch: 'main',
    title: 't',
    body: 'b',
    draft: false,
    existing: null,
    priorCreate: null,
  };

  it('the MR identity comes from the create response, recorded with the action id', async () => {
    const forge = fakeForge({ createMr: async () => ({ value: mr({ iid: 42, id: 'g-42' }) }) });
    const got = await ensureMr(
      { forge, forgeKind: 'gitlab', outbox: memOutbox(), self: 'bot' },
      input,
    );
    expect(got).toMatchObject({
      kind: 'identified',
      via: 'create',
      record: { mrIid: 42, actionId: 'a1' },
    });
  });

  it('a recorded MR is never replaced; a branch named like an MR id is never parsed', async () => {
    const forge = fakeForge();
    const existing = {
      unitId: 'u1',
      forge: 'gitlab' as const,
      mrId: 'g-9',
      mrIid: 9,
      url: 'x',
      sourceBranch: 'mr-77',
      actionId: 'a0',
    };
    const got = await ensureMr(
      { forge, forgeKind: 'gitlab', outbox: memOutbox(), self: 'bot' },
      { ...input, sourceBranch: 'mr-77', existing },
    );
    expect(got).toEqual({ kind: 'existing', record: existing });
    expect(forge.log).toEqual([]);
  });

  it('after a crash mid-create the forge is read by branch, own author, from the action start', async () => {
    const seen: unknown[] = [];
    const forge = fakeForge({
      mrBySourceBranch: async (q) => {
        seen.push(q);
        return { value: mr({ iid: 5 }) };
      },
    });
    const got = await ensureMr(
      { forge, forgeKind: 'gitlab', outbox: memOutbox(), self: 'bot' },
      { ...input, priorCreate: { actionId: 'a0', startedAt: 1_000_000 } },
    );
    expect(got).toMatchObject({
      kind: 'identified',
      via: 'read',
      record: { mrIid: 5, actionId: 'a0' },
    });
    expect(seen).toEqual([
      { sourceBranch: 'agentdeck/u1', createdAfter: 1_000_000 - 300_000, author: 'bot' },
    ]);
    expect(forge.log).not.toContain('createMr');
  });

  it('an unreadable forge after a crash is unknown, never a second create', async () => {
    const forge = fakeForge({ mrBySourceBranch: async () => ({ unknown: 'timeout' }) });
    const got = await ensureMr(
      { forge, forgeKind: 'gitlab', outbox: memOutbox(), self: 'bot' },
      { ...input, priorCreate: { actionId: 'a0', startedAt: 1 } },
    );
    expect(got).toEqual({ kind: 'unknown', reason: 'mr by branch: timeout' });
    expect(forge.log).not.toContain('createMr');
  });

  it('the body is updated only when its hash moved', async () => {
    const forge = fakeForge();
    const outbox = memOutbox();
    expect(await syncMrBody({ forge, outbox }, { url: 'u', iid: 7, title: 't', body: 'new' })).toBe(
      'updated',
    );
    expect(outbox.calls[0]).toMatchObject({ kind: 'mr-update' });
  });

  it('the description is numbered steps and names the sibling MRs', () => {
    const d = buildMrDescription({
      title: ' Add  x ',
      summary: 'Adds x.',
      requirements: [
        { text: 'x works', verdict: 'met', checks: [{ name: 'x test', result: 'passed' }] },
      ],
      linked: [{ name: 'web', url: 'https://tracker.example.com/w/-/merge_requests/2' }],
      testing: ['open the page', 'press x'],
    });
    expect(d.title).toBe('Add x');
    expect(d.body).toContain('## Related merge requests');
    expect(d.body).toContain('1. open the page\n2. press x');
    expect(d.body).not.toMatch(/step \d/i);
  });
});

describe('publisher after', () => {
  const thread = (id: string, author: string, over: Partial<ForgeThread> = {}): ForgeThread => ({
    id,
    resolvable: true,
    resolved: false,
    notes: [{ id: `${id}n`, author, body: 'q', bodyHash: 'q', createdAt: 0 }],
    ...over,
  });

  it('threads and conflict are read once when the MR opens: reviewer threads only, with their reviewer note ids', async () => {
    const answered = thread('t1', 'rev');
    answered.notes.push({ id: 'own', author: 'bot', body: 'a', bodyHash: 'a', createdAt: 1 });
    const forge = fakeForge({
      threads: async () => ({
        value: [answered, thread('t2', 'bot'), thread('t3', 'rev', { resolvable: false })],
      }),
      mergeability: async () => ({ value: 'conflict' as const }),
    });
    // Заметки — только чужие и только из нитей ревьюера: по ним опрос форжа поймёт, что задача
    // ответов их уже разобрала (05:77); своя заметка и не разрешаемая нить сюда не входят.
    expect(await readOnce(forge, { iid: 7, self: 'bot', localConflict: false })).toEqual({
      value: {
        mrIid: 7,
        threads: [{ id: 't1', resolved: false }],
        conflict: true,
        notes: ['t1n'],
      },
    });
  });

  it('a forge still checking mergeability is unknown, not clean', async () => {
    const forge = fakeForge({ mergeability: async () => ({ value: 'checking' as const }) });
    expect(await readOnce(forge, { iid: 7, self: 'bot', localConflict: false })).toEqual({
      unknown: 'mergeability: the forge is still checking',
    });
  });

  it('replies: a done action is not repeated; an own note already there only resolves', async () => {
    const forge = fakeForge();
    const outbox = memOutbox();
    const posted = thread('t2', 'rev');
    posted.notes.push({
      id: 'm',
      author: 'bot',
      body: 'fixed',
      bodyHash: noteHash('fixed'),
      createdAt: 1,
    });
    const out = await sendReplies(
      { forge, outbox, self: 'bot' },
      {
        url: 'u',
        iid: 7,
        replies: [
          { threadId: 't1', text: 'done', resolve: true },
          { threadId: 't2', text: 'fixed', resolve: true },
        ],
        threads: [thread('t1', 'rev'), posted],
        doneHints: new Set(),
      },
    );
    expect(out.map((o) => o.kind)).toEqual(['sent', 'sent']);
    expect(forge.log).toEqual(['reply', 'resolve', 'resolve']);
    const again = await sendReplies(
      { forge, outbox, self: 'bot' },
      {
        url: 'u',
        iid: 7,
        replies: [{ threadId: 't1', text: 'done', resolve: true }],
        threads: [],
        doneHints: new Set([`${outbox.calls[0]!.target}\n${outbox.calls[0]!.hint}`]),
      },
    );
    expect(again).toEqual([{ kind: 'skipped', threadId: 't1', why: 'already-done' }]);
  });

  it('CI is waited for only on a live human decision and never after publish-now', () => {
    expect(wantsCi({ ciWait: true, publishNow: false })).toBe(true);
    expect(wantsCi({ ciWait: false, publishNow: false })).toBe(false);
    expect(wantsCi({ ciWait: true, publishNow: true })).toBe(false);
  });
});
