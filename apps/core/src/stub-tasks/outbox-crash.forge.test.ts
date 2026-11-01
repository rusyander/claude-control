import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionKind } from '@agentdeck/contracts/core/journal';
import type { ForgePort } from '@agentdeck/contracts/core/forge';
import { startStubForge, type StubForge } from '@agentdeck/stub-forge';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createForgePort,
  forgeActionKey,
  mrBodyHash,
  noteHash,
  type ForgeActionKey,
} from '../adapters/forge/index.ts';
import { actionReaders } from '../bootstrap/action-readers.ts';
import { runAction } from '../conductor/outbox.ts';
import { reconcileTask } from '../conductor/reconcile.ts';
import { deps, openFresh } from '../journal/__fixtures__/journal-harness.ts';
import { STALE_MS } from '../journal/lease.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import { resume, type LiveTask } from '../journal/resume.ts';
import { READ_BY_FORGE, STUB_TASKS } from './__fixtures__/library/index.ts';
import type { Phase2Probe, ReconcileExpect } from './__fixtures__/stub-tasks.types.ts';

/**
 * Крах внутри действий публикации (P86, P10 половина читателя): ядро умирает после
 * `action.started` — до эффекта или после него. Мир — настоящий голый репозиторий (пуш, удаление
 * ветки) и заглушка форжа (MR, ответ в нити); новое ядро открывает журнал с диска и сверяет по
 * факту, прочитанному только из цели и подсказки. Эффектов в мире после сверки ровно столько,
 * сколько успело до среза: повтора вслепую нет.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

let stub: StubForge | undefined;
afterEach(async () => {
  await stub?.stop();
  stub = undefined;
});

interface World {
  key: ForgeActionKey;
  effect(): Promise<void>;
  /** Сколько раз эффект виден В МИРЕ (ветка, MR, заметка), а не счётчик теста. */
  count(): Promise<number>;
  port?: ForgePort;
}

const REF = 'refs/heads/feat';

function repoWorld(kind: 'push' | 'ref-delete'): World {
  const root = mkdtempSync(join(tmpdir(), 'outbox-forge-'));
  roots.push(root);
  const bare = join(root, 'remote.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '-q', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 'qa@tracker.example.com');
  git(work, 'config', 'user.name', 'qa');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'a');
  const before = git(work, 'rev-parse', 'HEAD');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'b');
  const sha = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', bare, `${before}:${REF}`);
  const at = () => {
    const line = git(bare, 'for-each-ref', '--format=%(objectname)', REF);
    return line || null;
  };
  if (kind === 'push') {
    return {
      key: { kind, url: bare, ref: REF, sha, before },
      effect: async () => void git(work, 'push', '-q', '-f', bare, `${sha}:${REF}`),
      count: async () => (at() === sha ? 1 : 0),
    };
  }
  return {
    key: { kind, url: bare, ref: REF, sha: before },
    effect: async () => void git(work, 'push', '-q', bare, `:${REF}`),
    count: async () => (at() === null ? 1 : 0),
  };
}

async function forgeWorld(kind: 'mr-create' | 'mr-update' | 'thread-reply'): Promise<World> {
  stub = await startStubForge({ scenario: 'review-threads-unseen' });
  const s = stub;
  const url = `${s.url}/acme/app.git`;
  const port = createForgePort({
    project: { kind: 'gitlab', ref: 'acme/app', baseUrl: s.url, pushUrl: url },
    token: s.tokens.publisher!,
    fetch: globalThis.fetch,
  });
  const open = () =>
    port.createMr({
      sourceBranch: 'feat',
      targetBranch: 'main',
      title: 't',
      body: 'old',
      draft: false,
    });
  const mrs = () => s.state().mrs.filter((m) => m.sourceBranch === 'feat');
  if (kind === 'mr-create') {
    return {
      port,
      key: { kind, url, sourceBranch: 'feat', bodyHash: mrBodyHash('t', 'old') },
      effect: async () => void (await open()),
      count: async () => mrs().length,
    };
  }
  const created = await open();
  if (!('value' in created)) throw new Error('stub MR not created');
  const iid = created.value.iid;
  if (kind === 'mr-update') {
    return {
      port,
      key: { kind, url, iid, bodyHash: mrBodyHash('t', 'new') },
      effect: async () => void (await port.updateMr(iid, { body: 'new' })),
      count: async () => {
        const mr = await port.mr(iid);
        return 'value' in mr && mr.value.bodyHash === mrBodyHash('t', 'new') ? 1 : 0;
      },
    };
  }
  const threads = await port.threads(iid);
  if (!('value' in threads) || !threads.value[0]) throw new Error('scenario threads missing');
  const threadId = threads.value[0].id;
  const notes = async () => {
    const now = await port.threads(iid);
    if (!('value' in now)) throw new Error('threads unreadable');
    const t = now.value.find((x) => x.id === threadId);
    return (
      t?.notes.filter((n) => n.author === 'publisher' && n.bodyHash === noteHash('done')) ?? []
    );
  };
  return {
    port,
    key: { kind, url, iid, threadId, bodyHash: noteHash('done'), resolve: true },
    effect: async () => {
      await port.reply(iid, threadId, 'done');
      await port.resolve(iid, threadId);
    },
    count: async () => (await notes()).length,
  };
}

type ReconcileProbe = Extract<Phase2Probe, { kind: 'reconcile' }>;

const PROBES: [ActionKind, string, ReconcileExpect][] = STUB_TASKS.flatMap((t) =>
  t.phase2
    .filter((p): p is ReconcileProbe => p.kind === 'reconcile')
    .filter((p) => READ_BY_FORGE.includes(p.action))
    .map((p) => [p.action, p.cut, p.expect] as [ActionKind, string, ReconcileExpect]),
);

describe('outbox crash inside every publish action (P86, P10 reader half)', () => {
  it('the library cuts each publish kind both ways and expects a fact verdict', () => {
    expect(PROBES.map(([k, c]) => `${k} ${c}`).sort()).toEqual(
      READ_BY_FORGE.flatMap((k) => [`${k} after-effect`, `${k} before-effect`]).sort(),
    );
  });

  it.each(PROBES)(
    '%s killed %s: the new core reconciles by the forge fact',
    async (kind, cut, want) => {
      const world =
        kind === 'push' || kind === 'ref-delete'
          ? repoWorld(kind)
          : await forgeWorld(kind as 'mr-create' | 'mr-update' | 'thread-reply');
      const fresh = await openFresh();
      let task: LiveTask | undefined;
      try {
        let reached!: () => void;
        const atCut = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const { target, idempotencyHint } = forgeActionKey(world.key);
        void runAction(fresh.task, { kind, target, idempotencyHint }, async () => {
          if (cut === 'after-effect') await world.effect();
          reached();
          return new Promise(() => undefined);
        });
        await atCut;
        const reopened = await resume(
          fresh.dir,
          fresh.taskId,
          deps({ isAlive: async () => 'dead', now: () => Date.now() + STALE_MS + 1_000 }),
        );
        if (!reopened.ok) throw new Error(reopened.reason);
        task = reopened.task;
        const before = task.state.seq;
        const readers = actionReaders(world.port ? { forgeFor: () => world.port! } : {});
        const decisions = await reconcileTask(task, readers, { now: () => 1_000 }, new Map());
        expect(decisions.map((d) => d.verdict)).toEqual([want.verdict]);
        const kinds = readJournalLines(task.dir, task.taskId)
          .lines.filter((l) => l.seq > before)
          .map((l) => l.kind);
        if (want.then) expect(kinds).toContain(want.then);
        // Сверка не повторила эффект: в мире ровно столько, сколько успело до среза.
        expect(await world.count()).toBe(cut === 'after-effect' ? 1 : 0);
      } finally {
        task?.close();
        try {
          fresh.task.close();
        } catch {
          // аренда уже у нового ядра — закрытие старого писателя может отказать, не предмет теста
        }
      }
    },
  );
});
