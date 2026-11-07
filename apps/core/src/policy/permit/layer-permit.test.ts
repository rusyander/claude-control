import { describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { platformDenySet } from '../../adapters/deny-overlay.ts';
import { decidePermit } from './permit.ts';
import type { PermitContext } from './permit.types.ts';

/**
 * Навык и подагент человека (06:115, 06:124, G5, F25): судья пускает их только по фактам слоя
 * сеанса. Навык — iff навыки `on` (и на шаге чтения: только инструкции); подагент — iff проба
 * доказала хук ядра внутри (`allowed`), модель вызова или определения не выше потолка, ранг
 * неизвестен — отказ с именем определения; `inherit`/нет модели — модель сеанса.
 */

const BASE: PermitContext = {
  copyRoot: '/work/copy',
  ownedPaths: [],
  deny: platformDenySet({ coreHome: '/core-home', tokenFiles: [] }),
  platformPaths: ['/core-home'],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const RANKS: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 };
const DEFINITIONS: Record<string, string | null> = {
  cheap: 'haiku',
  big: 'opus',
  odd: 'mystery-model',
  heir: 'inherit',
  plain: null,
};

function subagents(over: Partial<NonNullable<PermitContext['subagents']>> = {}): PermitContext {
  return {
    ...BASE,
    subagents: {
      allowed: true,
      ceilingRank: 2,
      modelRank: (m) => RANKS[m] ?? null,
      definitionModel: (t) => DEFINITIONS[t] ?? null,
      readOnlyHolds: true,
      ...over,
    },
  };
}

const skill = (target: string): PermissionAsk => ({
  action: 'skill',
  target,
  tool: 'Skill',
  display: `Skill ${target}`,
});
const agent = (target: string, model: string | null = null): PermissionAsk => ({
  action: 'subagent',
  target,
  model,
  tool: 'Agent',
  display: `Agent ${target}`,
});

describe('skill: allowed iff user skills are on', () => {
  it('skills on → allowed, also on a read-only step (instructions only)', () => {
    const ctx = { ...BASE, layer: { skills: 'on' as const } };
    expect(decidePermit(skill('pdf'), ctx)).toEqual({
      allow: true,
      signal: null,
      reason: 'skill pdf: user skills are on',
    });
    expect(decidePermit(skill('pdf'), ctx, 'review')).toMatchObject({ allow: true });
  });

  it('skills off, or no layer facts → skills-off, named', () => {
    expect(decidePermit(skill('pdf'), { ...BASE, layer: { skills: 'off' } })).toEqual({
      allow: false,
      code: 'skills-off',
      reason: 'skill pdf: user skills are off for this session',
      humanPoint: null,
    });
    expect(decidePermit(skill('pdf'), BASE)).toMatchObject({
      allow: false,
      code: 'skills-off',
      reason: 'skill pdf: no user layer facts',
    });
  });
});

describe('subagent: proven, within the ceiling, rank known (G5, F25)', () => {
  it('unproven or no facts → subagent-unproven', () => {
    expect(decidePermit(agent('cheap'), BASE)).toMatchObject({
      allow: false,
      code: 'subagent-unproven',
    });
    expect(decidePermit(agent('cheap'), subagents({ allowed: false }))).toMatchObject({
      allow: false,
      code: 'subagent-unproven',
      reason: 'subagent cheap: the probe has not proven core hooks hold inside subagents',
    });
  });

  it('explicit model above the ceiling → model-above-ceiling; at or below → allowed', () => {
    const ctx = subagents();
    expect(decidePermit(agent('plain', 'opus'), ctx)).toEqual({
      allow: false,
      code: 'model-above-ceiling',
      reason: 'subagent plain: requested model opus is above the task ceiling',
      humanPoint: null,
    });
    expect(decidePermit(agent('plain', 'sonnet'), ctx)).toMatchObject({ allow: true });
    expect(decidePermit(agent('big', 'haiku'), ctx)).toMatchObject({
      allow: true,
      reason: 'subagent big: requested model haiku within the ceiling',
    });
  });

  it('no explicit model → the definition model is judged; inherit/none → session model', () => {
    const ctx = subagents();
    expect(decidePermit(agent('big'), ctx)).toMatchObject({
      allow: false,
      code: 'model-above-ceiling',
      reason: 'subagent big: definition big model opus is above the task ceiling',
    });
    expect(decidePermit(agent('cheap'), ctx)).toMatchObject({ allow: true });
    for (const t of ['heir', 'plain', 'general-purpose'])
      expect(decidePermit(agent(t), ctx)).toEqual({
        allow: true,
        signal: null,
        reason: `subagent ${t}: inherits the session model`,
      });
  });

  it('unknown rank (model or ceiling) → subagent-model-unknown naming the definition', () => {
    expect(decidePermit(agent('odd'), subagents())).toEqual({
      allow: false,
      code: 'subagent-model-unknown',
      reason: 'subagent odd: definition odd model mystery-model has no known rank',
      humanPoint: null,
    });
    expect(decidePermit(agent('plain', 'fable'), subagents())).toMatchObject({
      code: 'subagent-model-unknown',
    });
    expect(decidePermit(agent('cheap'), subagents({ ceilingRank: null }))).toMatchObject({
      allow: false,
      code: 'subagent-model-unknown',
      reason: 'subagent cheap: definition cheap model haiku, but the ceiling rank is unknown',
    });
  });

  it('no named ceiling: the CLI-reported model judges; an unranked report is no ceiling (chat allows, unit denies)', () => {
    const reported = (model: string | null) =>
      subagents({
        ceilingRank: null,
        reportedCeiling: () => (model === null ? null : { model, rank: RANKS[model] ?? null }),
      });
    expect(decidePermit(agent('plain', 'opus'), reported('sonnet'))).toMatchObject({
      allow: false,
      code: 'model-above-ceiling',
      reason:
        'subagent plain: requested model opus is above the session ceiling sonnet (reported by the CLI)',
    });
    const odd = { ...reported('glm-4.6') };
    expect(decidePermit(agent('plain', 'haiku'), odd)).toMatchObject({
      allow: false,
      code: 'subagent-model-unknown',
    });
    odd.subagents = { ...odd.subagents!, openWithoutCeiling: true };
    expect(decidePermit(agent('plain', 'haiku'), odd)).toEqual({
      allow: true,
      signal: null,
      reason:
        'subagent plain: requested model haiku, no ceiling is known for this chat (the CLI reported model glm-4.6, which has no known rank)',
    });
  });

  it('read-only step: allowed only when the denies hold inside the subagent', () => {
    expect(decidePermit(agent('cheap'), subagents(), 'review')).toMatchObject({ allow: true });
    expect(
      decidePermit(agent('cheap'), subagents({ readOnlyHolds: false }), 'review'),
    ).toMatchObject({ allow: false, code: 'read-only-step' });
    expect(decidePermit(agent('cheap'), subagents({ readOnlyHolds: false }), 'work')).toMatchObject(
      { allow: true },
    );
  });
});
