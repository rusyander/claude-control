import { leadSectionSchema, LEAD_PROFILE_DEFAULTS } from '@agentdeck/contracts/core/lead';
import { stepDefSchema } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import { MINI_SCENARIO } from '../../journal/__fixtures__/journal-harness.ts';
import { resolveLeadSettings } from './index.ts';

/**
 * Действующие настройки ведущего (P144, D11): таблица W1-4. Раздел подаётся уже разобранным
 * схемой — так, как его отдаст читатель настройки ядра, — поэтому отказы схемы здесь же.
 */

const REPO = 'C:/work/p';
const section = (raw: unknown) => leadSectionSchema.parse(raw);

describe('lead settings resolver', () => {
  it('no section: balanced, parallelism 4, every role from the profile', () => {
    const r = resolveLeadSettings({ section: undefined, repoKey: REPO, machine: {} });
    expect(r.settings.profile).toBe('balanced');
    expect(r.settings.parallelism).toBe(4);
    expect(r.settings.roles.review).toEqual({ tier: 'ceiling', effort: 'high' });
    expect(Object.values(r.sources).every((s) => s === 'profile')).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('economy → 2, max-quality → 6 (machine slots wide enough)', () => {
    const at = (profile: string) =>
      resolveLeadSettings({
        section: section({ defaults: { profile } }),
        repoKey: null,
        machine: { sessionSlots: 6 },
      }).settings.parallelism;
    expect(at('economy')).toBe(2);
    expect(at('max-quality')).toBe(6);
  });

  it('the project override wins over the machine defaults, field by field and role by role', () => {
    const lead = section({
      defaults: {
        profile: 'economy',
        parallelism: 1,
        roles: { review: { tier: 'ceiling', effort: 'medium' } },
      },
      projects: {
        [REPO]: { parallelism: 3, roles: { review: { tier: 'ceiling', effort: 'xhigh' } } },
      },
    });
    const r = resolveLeadSettings({ section: lead, repoKey: REPO, machine: { sessionSlots: 6 } });
    expect(r.settings.profile).toBe('economy');
    expect(r.sources.profile).toBe('defaults');
    expect(r.settings.parallelism).toBe(3);
    expect(r.sources.parallelism).toBe('project');
    expect(r.settings.roles.review).toEqual({ tier: 'ceiling', effort: 'xhigh' });
    expect(r.roleSources.review).toBe('project');
    expect(r.roleSources.plan).toBe('profile');
    // Другой проект правку не видит.
    const other = resolveLeadSettings({ section: lead, repoKey: 'C:/work/q', machine: {} });
    expect(other.settings.parallelism).toBe(1);
    expect(other.settings.roles.review.effort).toBe('medium');
  });

  it('a project profile picks the profile table the project patch lands on', () => {
    const lead = section({
      defaults: { profile: 'economy' },
      projects: { [REPO]: { profile: 'max-quality' } },
    });
    const r = resolveLeadSettings({ section: lead, repoKey: REPO, machine: {} });
    expect(r.settings.profile).toBe('max-quality');
    expect(r.settings.roles.review).toEqual(LEAD_PROFILE_DEFAULTS['max-quality'].roles?.review);
  });

  it('a project profile pick resets profile-made fields that machine patches set, shared fields stay', () => {
    const lead = section({
      defaults: {
        parallelism: 5,
        roles: { review: { tier: 'ceiling', effort: 'medium' } },
        alwaysAsk: ['split'],
      },
      projects: { [REPO]: { profile: 'economy' } },
    });
    const r = resolveLeadSettings({ section: lead, repoKey: REPO, machine: { sessionSlots: 6 } });
    expect(r.settings.profile).toBe('economy');
    expect(r.settings.parallelism).toBe(2);
    expect(r.sources.parallelism).toBe('profile');
    expect(r.settings.roles.review).toEqual(LEAD_PROFILE_DEFAULTS.economy.roles?.review);
    expect(r.roleSources.review).toBe('profile');
    // Поле, одинаковое у всех профилей, профиль не задаёт — правка машины остаётся.
    expect(r.settings.alwaysAsk).toEqual(['split']);
    expect(r.sources.alwaysAsk).toBe('defaults');
    // Проект без своего профиля по-прежнему получает правки машины.
    const other = resolveLeadSettings({ section: lead, repoKey: 'C:/work/q', machine: {} });
    expect(other.settings.parallelism).toBe(5);
    expect(other.settings.roles.review.effort).toBe('medium');
  });

  it('parallelism 6 on a machine with sessionSlots 3 → 3 and a named warning', () => {
    const r = resolveLeadSettings({
      section: section({ projects: { [REPO]: { parallelism: 6 } } }),
      repoKey: REPO,
      machine: { sessionSlots: 3 },
    });
    expect(r.settings.parallelism).toBe(3);
    expect(r.warnings).toEqual([
      { field: 'parallelism', asked: 6, applied: 3, cap: 'queue.sessionSlots', source: 'project' },
    ]);
  });

  it('effort max in a role row is a schema refusal, never reaching the resolver', () => {
    const res = leadSectionSchema.safeParse({
      defaults: { roles: { implement: { tier: 'ceiling', effort: 'max' } } },
    });
    expect(res.success).toBe(false);
  });

  it('onlyFor with an unknown class is a schema refusal', () => {
    const step = MINI_SCENARIO.steps[0];
    expect(stepDefSchema.safeParse({ ...step, onlyFor: ['S', 'XXL'] }).success).toBe(false);
    expect(stepDefSchema.safeParse({ ...step, onlyFor: ['S'] }).success).toBe(true);
  });
});
