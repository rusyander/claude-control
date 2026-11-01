import { describe, expect, it } from 'vitest';
import type { CheckAnswer } from '@agentdeck/contracts/core/records';
import { modelCheck, type ModelCheckContext } from '../../conductor/checks/model-tool.ts';
import { unitDiff } from '../../conductor/model-tools/unit-diff.ts';
import { buildBrief } from '../brief/brief.ts';
import type { BriefPart } from '../brief/brief.types.ts';
import { reviewPack } from '../review-pack/review-pack.ts';
import { deltaOf } from '../sent/sent.ts';
import { maskSink } from './sinks.ts';

/**
 * P61 по выходам к модели: ключ из окружения, из файла копии и из вывода проверки не доходит ни
 * до брифа, ни до дельты, ни до пакета ревью, ни до выдержки проверки, ни до `unit_diff`. Один
 * набор посадок на все выходы — мутант «нет маски на одном выходе» краснит ровно свой случай.
 */

const ENV_SECRET = 'hunter2-session-pass'; // форма не узнаётся детектором — только по значению
const FILE_SECRET = `glpat-${'f'.repeat(20)}`;
const CHECK_SECRET = `sk-ant-${'c'.repeat(30)}`;
const SHA = 'e'.repeat(40);
const planted = `env ${ENV_SECRET} file ${FILE_SECRET} check ${CHECK_SECRET} commit ${SHA}`;
const known = [ENV_SECRET];

function noSecret(text: string): void {
  for (const s of [ENV_SECRET, FILE_SECRET, CHECK_SECRET]) expect(text).not.toContain(s);
  // Срез посреди ключа оставил бы узнаваемый хвост.
  expect(text).not.toContain('f'.repeat(12));
  expect(text).not.toContain('c'.repeat(12));
}

const part = (id: BriefPart['id'], text: string): BriefPart => ({ id, text, from: 'test' });

const ctx: ModelCheckContext = {
  taskId: '0192f000-0000-7000-8000-0000000000aa',
  stepId: '0192f000-0000-7000-8000-0000000000bb',
  project: 'p',
  copyDir: 'C:/copy',
  class: 'work',
  phase: 'mid-task',
  registryUnits: ['pkg'],
  changedUnits: ['pkg'],
  packageChecks: ['unit'],
  known,
};

describe('P61 — a planted secret never reaches a model sink', () => {
  it('brief', () => {
    const got = buildBrief([part('handoff', planted)], 'work', known);
    noSecret(got.text);
    expect(got.text).toContain(SHA);
  });

  it('delta', () => {
    const got = deltaOf({}, [part('handoff', planted)], 'work', known)!;
    noSecret(got.text);
    expect(got.text).toContain(SHA);
  });

  it('review pack', () => {
    const got = reviewPack({
      unitId: 'u1',
      baseRef: 'main',
      files: [{ path: '.env', added: 1, deleted: 0, binary: false, diff: `+${planted}` }],
      requirements: [{ id: 'r', ordinal: 1, text: `use ${FILE_SECRET}`, verdict: 'unknown' }],
      records: [],
      known,
    });
    noSecret(got.text);
  });

  it('check excerpt (model tool `check`): reason, failing names, every unit, before the 4000 slice', async () => {
    const answer: CheckAnswer = {
      kind: 'ran',
      recordId: 'rec-1',
      checkRunId: '0192f000-0000-7000-8000-0000000000cc',
      verdict: { kind: 'fail', reason: 'red' },
      exit: 1,
      failing: [{ file: 'a.test.ts', name: `token ${CHECK_SECRET} leaked` }],
      note: `output: ${planted}`,
    };
    const reply = await modelCheck(
      {
        requestCheck: async () => answer,
        logPath: () => null,
      } as unknown as Parameters<typeof modelCheck>[0],
      { checkId: 'unit' },
      ctx,
    );
    expect(reply.verdict).toBe('fail');
    noSecret(reply.excerpt);
    noSecret(reply.reason ?? '');
    noSecret(JSON.stringify(reply.units));
  });

  it('unit_diff', async () => {
    const got = await unitDiff(
      { file: '.env' },
      {
        changed: async () => ({ value: ['.env'] }),
        diffOf: async () => ({ value: planted }),
        known,
      },
    );
    expect(got.ok).toBe(true);
    if (got.ok) noSecret(got.diff);
  });

  it('the env value shorter than 8 chars is left as a word (no eaten text)', () => {
    expect(maskSink('a short pw', 'brief', ['pw']).text).toBe('a short pw');
  });
});
