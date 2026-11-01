import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import { describe, expect, it } from 'vitest';
import type { CliAdapter, PermissionAsk } from '../../adapters/adapter.types.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { CREATED, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { layoutOf } from '../../platform/core-home.ts';
import { decidePermit } from '../../policy/permit/permit.ts';
import { createSessionRoad } from './road.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Факты слоя в контексте права настоящей дорогой сессии (06:115, 06:124, G5): режим навыков —
 * из запуска шага, подагенты — из `caps.subagentHooks` переходника, модель определения — из описи
 * слоя сеанса. До этапа 7 дорога этих полей не ставила, и навык с подагентом отказывались всегда.
 */

const INVENTORY: UserLayerInventory = {
  cli: 'claude',
  hash: 'h1',
  sources: [],
  hooks: [],
  skills: [],
  agents: [
    { name: 'big', model: 'opus', path: '/a/big.md' },
    { name: 'plain', model: null, path: '/a/plain.md' },
  ],
  unread: [],
};

const skill: PermissionAsk = {
  action: 'skill',
  target: 'review',
  tool: 'Skill',
  display: 'Skill review',
};
const agent = (target: string, model: string | null = null): PermissionAsk => ({
  action: 'subagent',
  target,
  model,
  tool: 'Agent',
  display: `Agent ${target}`,
});

async function stand(opts: { skills: 'on' | 'off'; subagentHooks: boolean | null }) {
  const home = tempDir('core-home-');
  const { task } = await openFresh();
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: { ...CREATED, repos: [{ repoKey: 'r1', path: tempDir('src-'), baseRef: 'main' }] },
  });
  const seeded = seedSession(task, { stepKind: 'work' });
  const reads: boolean[] = [];
  const adapter = {
    id: 'claude',
    caps: { subagentHooks: opts.subagentHooks },
    readLayer: () => ({ dirs: [], credentials: [] }),
    inventory: (_pin: Record<string, string>, _cwd: string, repoLayer: boolean) => {
      reads.push(repoLayer);
      return INVENTORY;
    },
  } as unknown as CliAdapter;
  const road = createSessionRoad({
    layout: layoutOf(home),
    adapters: { get: (id: string) => (id === 'claude' ? adapter : undefined) },
  } as never);
  const start = {
    task,
    stepId: seeded.stepId,
    stepKind: 'work',
    sessionId: seeded.sessionId,
    adapterId: 'claude',
    model: null,
    cwd: tempDir('copy-'),
    dir: tempDir('session-'),
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    layer: { hooks: 'on', skills: opts.skills },
    pin: {},
  } as unknown as RoadStart;
  return { road, start, reads, sessionId: seeded.sessionId };
}

describe('session road: user layer facts in the permit context', () => {
  it('skills follow the step launch mode: on allows a Skill call, off denies it as skills-off', async () => {
    const on = await stand({ skills: 'on', subagentHooks: true });
    expect(decidePermit(skill, on.road.contextFor(on.start), 'work')).toMatchObject({
      allow: true,
    });
    const off = await stand({ skills: 'off', subagentHooks: true });
    expect(decidePermit(skill, off.road.contextFor(off.start), 'work')).toMatchObject({
      allow: false,
      code: 'skills-off',
    });
  });

  it('subagents run only where the adapter proved core hooks hold inside them', async () => {
    const proven = await stand({ skills: 'on', subagentHooks: true });
    expect(
      decidePermit(agent('plain'), proven.road.contextFor(proven.start), 'work'),
    ).toMatchObject({
      allow: true,
    });
    const unproven = await stand({ skills: 'on', subagentHooks: null });
    expect(
      decidePermit(agent('plain'), unproven.road.contextFor(unproven.start), 'work'),
    ).toMatchObject({ allow: false, code: 'subagent-unproven' });
  });

  it('a definition model from the session inventory is judged, not waved through as the session model', async () => {
    const s = await stand({ skills: 'on', subagentHooks: true });
    const ctx = s.road.contextFor(s.start);
    const big = decidePermit(agent('big'), ctx, 'work');
    expect(big).toMatchObject({ allow: false, code: 'subagent-model-unknown' });
    expect(big.reason).toContain('definition big');
    // Опись прочитана лениво, один раз, со слоем репозитория: строки старта со слоем у сеанса нет.
    decidePermit(agent('big'), ctx, 'work');
    expect(s.reads).toEqual([true]);
    expect(s.road.layerInventory(s.sessionId)?.hash).toBe('h1');
  });
});
