import { startStubForge, type StubAct, type StubForge } from '@agentdeck/stub-forge';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createForgePort } from '../../adapters/forge/index.ts';
import {
  guardStep,
  REAL_PUBLISH_TIMEOUT_MS,
  signalsOf,
  type GuardStep,
} from './__fixtures__/guard-stand.ts';

/**
 * P29: запись третьей стороны в форж под учёткой ядра во время шага (заметка, MR, правка MR,
 * одобрение, слияние) — `forged-publish` в конце шага. Та же запись другой учёткой или вне окна
 * шага — тишина. Форж — заглушка с часами теста; чтение — настоящий порт GitLab ядра.
 */

const T0 = 1_800_000_000_000;
let clock = T0;
let stub: StubForge;
let mrIid = 0;
beforeAll(async () => {
  stub = await startStubForge({ now: () => clock });
  mrIid = (
    stub.act('reviewer', {
      type: 'mr-open',
      sourceBranch: 'feature',
      targetBranch: 'main',
      title: 'target',
    }) as { iid: number }
  ).iid;
});
afterAll(() => stub.stop());

const open: GuardStep[] = [];
afterEach(() => {
  for (const one of open.splice(0)) one.done();
});

async function step(): Promise<GuardStep> {
  const port = createForgePort({
    project: { kind: 'gitlab', ref: '101', baseUrl: stub.url, pushUrl: 'unused' },
    token: stub.tokens['publisher']!,
    fetch: globalThis.fetch,
  });
  const one = await guardStep(port, () => clock);
  open.push(one);
  // MR единицы журнал знает — события по нему в окне шага судятся.
  one.t.append({
    kind: 'publish.mr',
    actor: 'core',
    unitId: one.s.unitId,
    data: {
      unitId: one.s.unitId,
      forge: 'gitlab',
      mrId: String(mrIid),
      mrIid,
      url: `${stub.url}/mr/${mrIid}`,
      sourceBranch: 'feature',
      actionId: '01920000-0000-7000-8000-00000000c001',
    },
  });
  return one;
}

/** Записи третьей стороны; MR открывается из ветки единицы — его номера журнал не знает. */
const writes = (branch: string): [string, StubAct][] => [
  ['note', { type: 'note', mrIid, body: 'looks fine' }],
  ['mr-update', { type: 'mr-update', mrIid, title: 'retitled' }],
  ['approval', { type: 'approval', mrIid }],
  ['merge', { type: 'merge', mrIid }],
  ['mr-open', { type: 'mr-open', sourceBranch: branch, targetBranch: 'main', title: 'second' }],
];

describe('P29 own-account forge writes during a step', { timeout: REAL_PUBLISH_TIMEOUT_MS }, () => {
  it.each([0, 1, 2, 3, 4])(
    'write #%i by the core account inside the step → forged-publish',
    async (i) => {
      clock += 10 * 60_000;
      const { t, st, hooks, s } = await step();
      const [type, act] = writes(st.branch)[i]!;
      await hooks.preStep!(s);
      clock += 1000;
      stub.act('publisher', act);
      clock += 1000;
      expect((await hooks.postStep!(s, null)).verdict).toMatchObject({ code: 'forged-publish' });
      expect(signalsOf(t)[0]?.detail).toContain(`forge-event: ${type}`);
    },
  );

  it('the same writes by another account → quiet', async () => {
    clock += 10 * 60_000;
    const { t, st, hooks, s } = await step();
    await hooks.preStep!(s);
    clock += 1000;
    for (const [, act] of writes(st.branch)) stub.act('reviewer', act);
    clock += 1000;
    expect((await hooks.postStep!(s, null)).verdict).toEqual({ ok: true });
    expect(signalsOf(t)).toEqual([]);
  });

  it('own write outside the step window (long before, past the clock skew) → quiet', async () => {
    clock += 10 * 60_000;
    stub.act('publisher', { type: 'note', mrIid, body: 'earlier, outside any step' });
    clock += 10 * 60_000;
    const { t, hooks, s } = await step();
    await hooks.preStep!(s);
    clock += 1000;
    expect((await hooks.postStep!(s, null)).verdict).toEqual({ ok: true });
    expect(signalsOf(t)).toEqual([]);
  });
});
