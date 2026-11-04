import { afterEach, describe, expect, it } from 'vitest';
import { SOLO_UNIT } from '../../journal/__fixtures__/journal-harness.ts';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { processCommand } from '../commands.ts';
import { envelope, homeTask, HUMAN_PROOF } from '../scenario/__fixtures__/scenario-harness.ts';
import { commandEnv } from './__fixtures__/command-env.ts';
import { refsOf } from './clean-remote.ts';
import type { CommandEnv } from './commands.types.ts';
import type { PublisherCommandPort } from './publisher-port.ts';

/**
 * P96: «опубликовать сейчас» ставит единицу в голову очереди и снимает ожидание CI — и НИЧЕГО
 * больше: открытый вопрос остаётся открытым. P102: `clean-remote` без порта публикатора —
 * честный отказ; ссылки — ровно названные.
 */

const open: LiveTask[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

function port(log: string[]): PublisherCommandPort {
  return {
    promote: (unitId) => log.push(`promote ${unitId}`),
    cleanRemote: async (_t, input) => {
      log.push(`clean ${input.refs.join(',')}`);
      return { deleted: input.refs, absent: [], failed: [] };
    },
    delivery: async (copy) => ({ missing: copy }),
  };
}

async function taskWithUnit(): Promise<{ t: LiveTask; unitId: string; askId: string }> {
  const { task: t } = await homeTask({});
  open.push(t);
  const unitId = newId();
  t.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: { unitId, repoKey: 'r1', branch: 'agentdeck/u', ownedPaths: [], ...SOLO_UNIT },
  });
  const askId = newId();
  t.append({
    kind: 'human.asked',
    actor: 'core',
    data: {
      askId,
      point: 8,
      source: 'ask_human',
      dedupe: null,
      question: 'Proceed?',
      options: [],
      defaultAction: null,
    },
  });
  return { t, unitId, askId };
}

const withPort = (log: string[]): CommandEnv =>
  ({ ...commandEnv(), publisher: () => port(log) }) as CommandEnv;

describe('publish-now (P96)', () => {
  it('applies with the unit id, promotes it in the queue, and leaves the open ask open', async () => {
    const { t, unitId, askId } = await taskWithUnit();
    const log: string[] = [];
    const got = await processCommand(
      t,
      envelope(t, 'publish-now', { unitId }),
      HUMAN_PROOF,
      withPort(log),
    );
    expect(got).toMatchObject({ status: 'applied', outcome: { unitId } });
    expect(log).toEqual([`promote ${unitId}`]);
    expect(publicationOf(t.state, unitId).publishNowSeq).toBe(got.seq);
    expect(t.state.asks[askId]?.state).toBe('open');
  });

  it('an unknown unit is rejected, nothing promoted', async () => {
    const { t } = await taskWithUnit();
    const log: string[] = [];
    const got = await processCommand(
      t,
      envelope(t, 'publish-now', { unitId: newId() }),
      HUMAN_PROOF,
      withPort(log),
    );
    expect(got).toMatchObject({ status: 'rejected' });
    expect(log).toEqual([]);
  });
});

describe('clean-remote (P102)', () => {
  it('without the publisher port: rejected publisher-unwired, never "deleted"', async () => {
    const { t } = await taskWithUnit();
    const got = await processCommand(
      t,
      envelope(t, 'clean-remote', { branches: ['agentdeck/u'] }),
      HUMAN_PROOF,
      commandEnv(),
    );
    expect(got).toMatchObject({ status: 'rejected', code: 'publisher-unwired' });
  });

  it('passes exactly the named refs to the port', async () => {
    const { t } = await taskWithUnit();
    const log: string[] = [];
    const got = await processCommand(
      t,
      envelope(t, 'clean-remote', { branches: ['agentdeck/u'], tags: ['v1'] }),
      HUMAN_PROOF,
      withPort(log),
    );
    expect(got).toMatchObject({ status: 'applied' });
    expect(log).toEqual(['clean refs/heads/agentdeck/u,refs/tags/v1']);
    expect(refsOf({ branches: ['refs/heads/a', 'b/c'] })).toEqual([
      'refs/heads/a',
      'refs/heads/b/c',
    ]);
  });
});

describe('publish-now (P96, stage 8 observer)', () => {
  it('a pending observer stop and an observer park survive publish-now; it raises no human point', async () => {
    const { t, unitId } = await taskWithUnit();
    const stepId = newId();
    const sessionId = newId();
    t.append({
      kind: 'step.started',
      actor: 'core',
      unitId,
      stepId,
      data: {
        stepId,
        unitId,
        stepKind: 'work',
        stepDefId: 'work',
        round: 0,
        scenario: { id: 'feature', version: 1 },
        budgetMs: 0,
      },
    });
    t.append({
      kind: 'session.started',
      actor: 'core',
      stepId,
      sessionId,
      data: {
        sessionId,
        stepId,
        adapter: 'claude',
        cliVersion: '1',
        route: { kind: 'cli-login', id: 'claude-login' },
        hops: [],
        credentialKind: 'none',
        modelAsked: null,
        modelServed: null,
        effort: null,
        hostPid: 1,
        hostStart: 'x',
        cliPid: null,
        cliStart: null,
        cwd: '/w',
        argv: [],
        resumeOf: null,
        cacheAgeMs: null,
      },
    });
    const observerRow = (signal: string, severity: 'warn' | 'stop', action: string) =>
      t.append({
        kind: 'signal',
        actor: 'core',
        stepId,
        sessionId,
        data: { signal, severity, action, subject: 'git push', detail: '' },
      } as never);
    observerRow('waste-refusal-repeat', 'stop', 'stop-step');
    observerRow('context-growth', 'warn', 'pause-at-safe-point');
    const stops = [...(t.state.steps[stepId]?.stops ?? [])];
    const park = t.state.sessions[sessionId]?.parkAsked;
    expect(stops).toEqual(['waste-refusal-repeat: git push']);
    expect(park?.signal).toBe('context-growth');
    const asksBefore = Object.keys(t.state.asks);

    const got = await processCommand(
      t,
      envelope(t, 'publish-now', { unitId }),
      HUMAN_PROOF,
      withPort([]),
    );
    expect(got).toMatchObject({ status: 'applied' });
    expect(t.state.steps[stepId]?.stops).toEqual(stops);
    expect(t.state.sessions[sessionId]?.parkAsked).toEqual(park);
    expect(Object.keys(t.state.asks)).toEqual(asksBefore);
  });
});
