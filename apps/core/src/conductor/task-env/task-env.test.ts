import { describe, expect, it } from 'vitest';
import type { EstimateBody } from '@agentdeck/contracts/core/estimate';
import { createTaskEnvBook, sessionProblems } from './task-env.ts';

/**
 * Окружение задачи (этап 10, F6): значения — только в книге памяти ядра, имена — в журнале;
 * оценка отказывает (422), когда имена и значения не сходятся в обе стороны или имя — своё ядра.
 */

const fields = (over: Partial<EstimateBody['fields']> = {}): EstimateBody['fields'] =>
  ({
    title: 't',
    request: 'r',
    repos: [{ path: 'C:/p', baseRef: null }],
    scenario: { preset: 'chat' },
    launchPolicy: 'confirm',
    ciWait: false,
    ...over,
  }) as EstimateBody['fields'];

describe('task env book', () => {
  it('holds a copy per task until dropped', () => {
    const book = createTaskEnvBook();
    const values = { A: '1' };
    book.put('t1', values);
    values.A = 'changed';
    expect(book.get('t1')).toEqual({ A: '1' });
    expect(book.size()).toBe(1);
    book.drop('t1');
    expect(book.get('t1')).toBeUndefined();
    expect(book.size()).toBe(0);
  });
});

describe('sessionProblems', () => {
  it('no session and no values — fine; values without names — refused', () => {
    expect(sessionProblems({ fields: fields() })).toEqual([]);
    expect(sessionProblems({ fields: fields(), env: { A: '1' } })).toEqual([
      'env: values without fields.session.env names',
    ]);
  });

  it('names and values match both ways — fine', () => {
    expect(
      sessionProblems({
        fields: fields({ session: { env: ['A', 'B'], brief: 'none' } }),
        env: { A: '1', B: '2' },
      }),
    ).toEqual([]);
  });

  it('a name without a value and a value without a name are each named', () => {
    expect(
      sessionProblems({
        fields: fields({ session: { env: ['A', 'B'] } }),
        env: { A: '1', C: '3' },
      }),
    ).toEqual(['session.env: no value for B', 'env: C not named in session.env']);
  });

  it('core-owned names are refused (PATH, NODE_OPTIONS, AGENTDECK_*, any case)', () => {
    const problems = sessionProblems({
      fields: fields({ session: { env: ['PATH', 'node_options', 'AGENTDECK_TOKEN', 'OK'] } }),
      env: { PATH: 'x', node_options: 'y', AGENTDECK_TOKEN: 'z', OK: 'ok' },
    });
    expect(problems).toEqual([
      'session.env: PATH, node_options, AGENTDECK_TOKEN are set by the core itself',
    ]);
  });

  it('G6: the panel variables (kit variant, tests note, tests project) pass; other AGENTDECK_* stay refused', () => {
    expect(
      sessionProblems({
        fields: fields({
          session: {
            env: ['AGENTDECK_KIT_VARIANT', 'AGENTDECK_TESTS_NOTE', 'AGENTDECK_TESTS_PROJECT'],
          },
        }),
        env: {
          AGENTDECK_KIT_VARIANT: 'light',
          AGENTDECK_TESTS_NOTE: '1',
          AGENTDECK_TESTS_PROJECT: 'C:/p',
        },
      }),
    ).toEqual([]);
    expect(
      sessionProblems({
        fields: fields({ session: { env: ['AGENTDECK_SESSION_TOKEN'] } }),
        env: { AGENTDECK_SESSION_TOKEN: 'x' },
      }),
    ).toEqual(['session.env: AGENTDECK_SESSION_TOKEN are set by the core itself']);
  });

  it('G6: sources and settingSources together are refused — the core does not guess which narrows', () => {
    expect(
      sessionProblems({
        fields: fields({ session: { sources: 'user', settingSources: ['project'] } }),
      }),
    ).toEqual(['session: sources and settingSources both narrow the setting sources — send one']);
    expect(
      sessionProblems({ fields: fields({ session: { settingSources: ['project', 'local'] } }) }),
    ).toEqual([]);
  });

  it('session settings outside the chat scenario are refused', () => {
    expect(
      sessionProblems({
        fields: fields({ scenario: { preset: 'feature' }, session: { brief: 'none' } }),
      }),
    ).toEqual(['session: only the chat scenario takes session settings']);
  });
});
