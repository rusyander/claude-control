import { parseCommand } from '@agentdeck/contracts/core/commands';
import { parseEstimateBody } from '@agentdeck/contracts/core/estimate';
import { scenarioProblems, scenarioSchema, type StepDef } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import { MINI_SCENARIO } from './journal/__fixtures__/journal-harness.ts';

/**
 * Контракты этапа 4 с логикой (волна 0): структурные проблемы сценария — одна функция на ядро
 * и редактор панели; тело оценки и правка требований — строгие, без умолчаний (P42).
 */

const WORK = MINI_SCENARIO.steps[0]!;
const step = (over: Partial<StepDef>): StepDef => ({ ...WORK, ...over });
const ID = '01920000-0000-7000-8000-00000000d001';

describe('stage-4 contracts', () => {
  it('the minimal scenario passes the schema and has no problems', () => {
    expect(scenarioSchema.safeParse(MINI_SCENARIO).success).toBe(true);
    expect(scenarioProblems(MINI_SCENARIO)).toEqual([]);
  });

  it('scenarioProblems names every structural fault: unknown after, cycle, ask rules, publish before final-gate', () => {
    const bad = {
      ...MINI_SCENARIO,
      steps: [
        step({ id: 'a', after: ['b'] }),
        step({ id: 'b', after: ['a'] }),
        step({ id: 'c', after: ['gone'] }),
        step({
          id: 'q',
          kind: 'ask-human',
          ask: { question: 'дальше?', options: ['да', 'нет'], recommendation: 'может быть' },
        }),
        step({ id: 'r', kind: 'review' }),
        step({ id: 'p', kind: 'publish', after: ['r'] }),
      ],
    };
    expect(scenarioProblems(bad)).toEqual([
      'c: after unknown step gone',
      'q: ask recommendation is not one of options',
      'cycle through a',
      'p: publish without a final-gate before it',
    ]);
    const gated = {
      ...MINI_SCENARIO,
      steps: [
        step({ id: 'g', kind: 'final-gate' }),
        step({ id: 'p', kind: 'publish', after: ['g'] }),
      ],
    };
    expect(scenarioProblems(gated)).toEqual([]);
  });

  it('estimate body: strict fields, an unknown field and a missing one are named issues', () => {
    const fields = {
      title: 'оценка',
      request: 'сделать',
      repos: [{ path: '/r', baseRef: null }],
      scenario: { preset: 'bug-fix' },
      launchPolicy: 'confirm',
      ciWait: false,
    };
    expect(parseEstimateBody({ cmdId: ID, fields, proof: {} }).ok).toBe(true);
    const extra = parseEstimateBody({ cmdId: ID, fields: { ...fields, zzz: 1 }, proof: {} });
    expect(extra.ok ? [] : extra.issues.map((i) => i.code)).toEqual(['unknown-field']);
    const { ciWait: _dropped, ...missing } = fields;
    const short = parseEstimateBody({ cmdId: ID, fields: missing, proof: {} });
    expect(short.ok ? [] : short.issues.map((i) => i.code)).toEqual(['missing-field']);
  });

  it('edit-requirements: an empty edit is refused, waive needs a reason', () => {
    const envelope = (fields: unknown) =>
      parseCommand({
        cmdId: ID,
        kind: 'edit-requirements',
        target: { taskId: ID },
        fields,
        proof: {},
      });
    expect(envelope({ add: [], waive: [] }).ok).toBe(false);
    expect(envelope({ add: [], waive: [{ requirementId: ID, reason: 'не нужно' }] }).ok).toBe(true);
    expect(envelope({ add: [], waive: [{ requirementId: ID }] }).ok).toBe(false);
  });
});
