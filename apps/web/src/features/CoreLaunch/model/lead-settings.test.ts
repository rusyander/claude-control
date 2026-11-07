import { describe, expect, it } from 'vitest';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import { resolveLeadSettings } from '@agentdeck/contracts/core/lead-resolve';
import {
  effectiveWith,
  estimateRoles,
  LEAD_EFFORTS,
  leadChanged,
  patchOf,
  patchProblems,
  scopeKeys,
  withAlwaysAsk,
  withLead,
  withoutRole,
  withParallelism,
  withProfile,
  withPromotion,
  withRoleField,
} from './leadSettings';

/**
 * Модель настроек ведения (этап 11, W3-16): правка уровня (машина или проект) поверх профиля;
 * действующие значения — резолвер ядра; запись — весь раздел `lead` с отпечатком, правка проекта
 * не трогает умолчания машины и прочие разделы.
 */

const view = (doc: ConfigView['doc'] = {}): ConfigView => ({
  doc,
  digest: 'd'.repeat(64),
  drift: null,
  issues: [],
});

describe('lead settings model (W3-16)', () => {
  it('profiles give parallelism 2 / 4 / 6 under the default machine cap', () => {
    const got = (['economy', 'balanced', 'max-quality'] as const).map(
      (p) => effectiveWith(view(), '', withProfile({}, p)).settings.parallelism,
    );
    expect(got).toEqual([2, 4, 6]);
  });

  it('the machine cap (queue.sessionSlots) cuts parallelism and names the cut', () => {
    const v = view({ queue: { sessionSlots: 3 } } as ConfigView['doc']);
    const eff = effectiveWith(v, '', withProfile({}, 'max-quality'));
    expect(eff.settings.parallelism).toBe(3);
    expect(eff.warnings).toEqual([
      { field: 'parallelism', asked: 6, applied: 3, cap: 'queue.sessionSlots', source: 'profile' },
    ]);
  });

  it('a project edit is written under lead.projects[key]; machine defaults untouched', () => {
    const v = view({ lead: { defaults: { parallelism: 3 } }, mcpPicks: { work: ['a'] } } as never);
    const { doc, baseDigest } = withLead(v, 'repo-1234abcd', withProfile({}, 'economy'));
    expect(doc.lead).toEqual({
      defaults: { parallelism: 3 },
      projects: { 'repo-1234abcd': { profile: 'economy' } },
    });
    expect((doc as { mcpPicks?: unknown }).mcpPicks).toEqual({ work: ['a'] });
    expect(baseDigest).toBe('d'.repeat(64));
  });

  it('machine scope writes lead.defaults; an empty patch removes the level, then the section', () => {
    const v = view({ lead: { projects: { r: { profile: 'economy' } } } });
    expect(withLead(v, '', { profile: 'max-quality' }).doc.lead).toEqual({
      defaults: { profile: 'max-quality' },
      projects: { r: { profile: 'economy' } },
    });
    expect(withLead(v, 'r', {}).doc.lead).toBeUndefined();
  });

  it('the draft starts from the written level and is "changed" only when it differs', () => {
    const v = view({ lead: { projects: { r: { profile: 'economy' } } } });
    expect(patchOf(v, 'r')).toEqual({ profile: 'economy' });
    expect(patchOf(v, '')).toEqual({});
    expect(leadChanged(v, 'r', { profile: 'economy' })).toBe(false);
    expect(leadChanged(v, 'r', { profile: 'balanced' })).toBe(true);
  });

  it('effective values equal the core resolver for the same section', () => {
    const v = view({
      lead: { defaults: { parallelism: 5 }, projects: { r: { profile: 'economy' } } },
    });
    const mine = effectiveWith(v, 'r', patchOf(v, 'r'));
    const core = resolveLeadSettings({ section: v.doc.lead, repoKey: 'r', machine: {} });
    expect(mine).toEqual(core);
    // Профиль проекта выбирает параллельность сам: правка машины по ней не действует.
    expect(mine.settings.parallelism).toBe(2);
  });

  it('effort options never carry max; a max written to a role is dropped', () => {
    expect(LEAD_EFFORTS).not.toContain('max');
    expect(LEAD_EFFORTS).toContain('xhigh');
    const patch = withRoleField({}, { tier: 'ceiling', effort: 'high' }, 'review', 'effort', 'max');
    expect(patch.roles?.review).toEqual({ tier: 'ceiling' });
    expect(patchProblems(patch)).toEqual([]);
  });

  it('a role row is written whole from the effective row; reset returns it to the profile', () => {
    const p1 = withRoleField({}, { tier: 'ceiling', effort: 'high' }, 'plan', 'model', 'opus');
    expect(p1.roles?.plan).toEqual({ tier: 'ceiling', effort: 'high', model: 'opus' });
    const p2 = withRoleField(p1, p1.roles!.plan!, 'plan', 'tier', 'raise-for-planning');
    expect(p2.roles?.plan).toEqual({ tier: 'raise-for-planning', effort: 'high', model: 'opus' });
    expect(withoutRole(p2, 'plan')).toEqual({});
  });

  it('parallelism is clamped to 1…6, empty means "from the profile"', () => {
    expect(withParallelism({}, '9').parallelism).toBe(6);
    expect(withParallelism({}, '0').parallelism).toBe(1);
    expect(withParallelism({ parallelism: 3 }, '')).toEqual({});
  });

  it('promotion and alwaysAsk are written whole; an invalid promotion is named', () => {
    const base = effectiveWith(view(), '', {}).settings;
    const bad = withPromotion({}, base.promotion, 'minSamples', '50');
    expect(patchProblems(bad)).toContain('promotion.minSamples');
    expect(withAlwaysAsk({}, [], 'split', true).alwaysAsk).toEqual(['split']);
    expect(withAlwaysAsk({}, ['intake', 'split'], 'intake', false).alwaysAsk).toEqual(['split']);
  });

  it('scope keys: written projects plus the ones the screen has seen, sorted, no machine key', () => {
    const v = view({ lead: { projects: { b: {}, a: {} } } });
    expect(scopeKeys(v, ['c', 'a', ''])).toEqual(['a', 'b', 'c']);
  });

  it('estimate roles follow the written project; a mismatched profile falls back to its defaults', () => {
    const v = view({ lead: { projects: { r: { profile: 'max-quality' } } } });
    expect(estimateRoles(v, 'r', 'max-quality').review).toEqual({
      tier: 'ceiling',
      effort: 'xhigh',
    });
    expect(estimateRoles(v, null, 'economy').review).toEqual({ tier: 'ceiling', effort: 'medium' });
  });
});
