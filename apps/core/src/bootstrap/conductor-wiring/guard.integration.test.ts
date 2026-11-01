import type { ForgeActivity, ForgePort } from '@agentdeck/contracts/core/forge';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { afterEach, describe, expect, it } from 'vitest';
import { forgeActionKey } from '../../adapters/forge/index.ts';
import { MINI_SCENARIO } from '../../journal/__fixtures__/journal-harness.ts';
import { remoteRefsKey } from '../../journal/reduce/publish.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import {
  guardStep,
  kindsOf as kinds,
  SESSION_ENV,
  signalsOf as signals,
  type GuardStep,
  REAL_PUBLISH_TIMEOUT_MS,
} from '../guard-wiring/__fixtures__/guard-stand.ts';

/**
 * Страж публикации на живой задаче и настоящем git (05 §Push closure, G6/G7): перед шагом копия
 * закрыта и база записана; push мимо ядра, дрейф закрытия и событие форжа своей учётки — в конце
 * шага `decision` + `signal forged-publish` и отказ шага; пуш, записанный в журнал, — работа ядра.
 */

const WORK = MINI_SCENARIO.steps[0] as StepDef;
const open: GuardStep[] = [];
afterEach(() => {
  for (const one of open.splice(0)) one.done();
});

function fakeForge(events: ForgeActivity[], account = 'core-bot'): ForgePort {
  return {
    kind: 'gitlab',
    whoAmI: async () => ({ value: { id: '1', username: account } }),
    mrBySourceBranch: async () => ({ absent: true }),
    activitySince: async () => ({ value: events }),
  } as unknown as ForgePort;
}

async function setup(forge: ForgePort | null = null): Promise<GuardStep> {
  const one = await guardStep(forge);
  open.push(one);
  return one;
}

describe('guard hooks', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it('preStep closes the copy and writes closure + remote baseline; a quiet step stays quiet', async () => {
    const { t, st, hooks, s, notes } = await setup();
    const pre = await hooks.preStep!(s);
    expect(pre.verdict).toEqual({ ok: true });
    expect(t.state.closures[s.unitId]?.pushurls).toEqual({
      origin: 'agentdeck-closed://push-refused',
    });
    const repoKey = t.state.units[s.unitId]?.repoKey;
    expect(repoKey).toBeTruthy();
    expect(t.state.remoteRefs[remoteRefsKey(repoKey, 'origin')]?.refs).toEqual({
      HEAD: expect.any(String),
      'refs/heads/main': expect.any(String),
    });
    expect(notes).toContain('guard.worktree-config');
    expect(st.run(st.copy, ['push', 'origin', st.branch], SESSION_ENV).status).not.toBe(0);
    const post = await hooks.postStep!(s, null);
    expect(post.verdict).toEqual({ ok: true });
    expect(signals(t)).toEqual([]);
    // Второй preStep той же копии не пишет второй строки закрытия.
    await hooks.preStep!(s);
    expect(kinds(t).filter((k) => k === 'publish.closure')).toHaveLength(1);
  });

  it('a bypass push lands on the remote → forged-publish stops the step', async () => {
    const { t, st, hooks, s } = await setup();
    await hooks.preStep!(s);
    const sha = st.commitIn(st.copy, 'b.txt');
    // Обход: явный адрес и метка снята — remote принял.
    expect(
      st.run(st.copy, ['push', '--no-verify', st.bare, `HEAD:refs/heads/${st.branch}`]).status,
    ).toBe(0);
    const post = await hooks.postStep!(s, null);
    expect(post.verdict).toMatchObject({ ok: false, stop: 'step', code: 'forged-publish' });
    expect(signals(t)).toEqual([
      expect.objectContaining({
        signal: 'forged-publish',
        severity: 'stop',
        detail: expect.stringContaining(
          `remote-sha: origin refs/heads/${st.branch} → ${sha.slice(0, 12)}`,
        ),
      }),
    ]);
    expect(kinds(t)).toContain('decision');
    // База переписана: следующий конец шага тот же пуш второй раз не называет.
    expect((await hooks.postStep!(s, null)).verdict).toEqual({ ok: true });
  });

  it('a bypass push hidden by resetting the branch afterwards is still ours (reflog)', async () => {
    const { t, st, hooks, s } = await setup();
    await hooks.preStep!(s);
    const sha = st.commitIn(st.copy, 'r.txt');
    st.g(st.copy, 'push', '-q', '--no-verify', st.bare, `HEAD:refs/heads/${st.branch}`);
    // Сеанс прячет след: ветка копии назад, коммит пуша виден только в reflog.
    st.g(st.copy, 'reset', '-q', '--hard', 'HEAD~1');
    expect((await hooks.postStep!(s, null)).verdict).toMatchObject({ code: 'forged-publish' });
    expect(signals(t)[0]?.detail).toContain(sha.slice(0, 12));
  });

  it('a journaled push with the same ref and sha is the core; another sha is forged', async () => {
    const { t, st, hooks, s } = await setup();
    await hooks.preStep!(s);
    const sha = st.commitIn(st.copy, 'c.txt');
    const ref = `refs/heads/${st.branch}`;
    const journal = (pushed: string) => {
      const { target, idempotencyHint } = forgeActionKey({
        kind: 'push',
        url: st.bare,
        ref,
        sha: pushed,
        before: null,
      });
      t.append({
        kind: 'action.started',
        actor: 'core',
        unitId: s.unitId,
        data: { actionId: newId(), kind: 'push', target, idempotencyHint },
      });
    };
    journal('d'.repeat(40));
    st.g(st.copy, 'push', '-q', st.bare, `HEAD:${ref}`);
    expect((await hooks.postStep!(s, null)).verdict).toMatchObject({ ok: false });
    const sha2 = st.commitIn(st.copy, 'd.txt');
    journal(sha2);
    st.g(st.copy, 'push', '-q', st.bare, `HEAD:${ref}`);
    expect(sha2).not.toBe(sha);
    expect((await hooks.postStep!(s, null)).verdict).toEqual({ ok: true });
  });

  it('drift of the closure is forged-publish; the next preStep re-closes and records it', async () => {
    const { t, st, hooks, s } = await setup();
    await hooks.preStep!(s);
    st.g(st.copy, 'config', '--worktree', 'core.hooksPath', '.git/hooks');
    st.g(st.main, 'config', 'alias.ship', '!git push origin HEAD');
    const post = await hooks.postStep!(s, null);
    expect(post.verdict).toMatchObject({ ok: false, code: 'forged-publish' });
    expect(signals(t)[0]?.detail).toContain('config-drift: core.hooksPath');
    expect(signals(t)[0]?.detail).toContain('config-drift: alias.ship');
    await hooks.preStep!(s);
    expect(kinds(t).filter((k) => k === 'publish.closure')).toHaveLength(2);
    expect(t.state.closures[s.unitId]?.commonAliases['ship']).toBe('!git push origin HEAD');
  });

  it('a push during a step that ended without postStep is judged by the next preStep', async () => {
    const { st, hooks, s } = await setup();
    await hooks.preStep!(s);
    st.commitIn(st.copy, 'e.txt');
    st.g(st.copy, 'push', '-q', '--no-verify', st.bare, `HEAD:refs/heads/${st.branch}`);
    const next = await hooks.preStep!(s);
    expect(next.verdict).toMatchObject({ ok: false, code: 'forged-publish' });
  });

  it('forge: own unjournaled note fires, a reviewer note does not; unread forge is a warn', async () => {
    const note = (author: string): ForgeActivity => ({
      id: newId(),
      type: 'note',
      author,
      at: Date.now(),
      mrIid: 4,
    });
    const own = await setup(fakeForge([note('reviewer'), note('core-bot')]));
    await own.hooks.preStep!(own.s);
    expect((await own.hooks.postStep!(own.s, null)).verdict).toMatchObject({ ok: false });
    expect(signals(own.t)[0]?.detail).toContain('forge-event: note !4 by core-bot');
    const other = await setup(fakeForge([note('reviewer')]));
    await other.hooks.preStep!(other.s);
    expect((await other.hooks.postStep!(other.s, null)).verdict).toEqual({ ok: true });
    const broken = {
      kind: 'gitlab',
      whoAmI: async () => ({ unknown: 'forge 503' }),
    } as unknown as ForgePort;
    const unread = await setup(broken);
    await unread.hooks.preStep!(unread.s);
    expect((await unread.hooks.postStep!(unread.s, null)).verdict).toEqual({ ok: true });
    expect(signals(unread.t)).toEqual([
      expect.objectContaining({
        severity: 'warn',
        detail: 'not checked: forge activity: account: forge 503',
      }),
    ]);
  });

  it('core steps and copies not yet made are not guarded', async () => {
    const { t, hooks, s } = await setup();
    expect((await hooks.preStep!({ ...s, def: { ...WORK, kind: 'check' } })).verdict).toEqual({
      ok: true,
    });
    expect((await hooks.postStep!({ ...s, copyDir: null }, null)).verdict).toEqual({ ok: true });
    expect(kinds(t)).not.toContain('publish.closure');
  });

  it('a repository whose common config is bare refuses the unit by name', async () => {
    const { st, hooks, s } = await setup();
    st.g(st.main, 'config', 'core.bare', 'true');
    const pre = await hooks.preStep!(s);
    expect(pre.verdict).toMatchObject({ ok: false, stop: 'unit', code: 'push-closure-refused' });
  });
});
