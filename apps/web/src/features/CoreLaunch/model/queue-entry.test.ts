import { describe, expect, it } from 'vitest';
import { boardEntryDraftSchema } from '@agentdeck/contracts/core/board';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import { defaultStopOf, entryDraftOf, STOP_CHOICES } from './queueEntry';

const fields: EstimateFields = {
  title: 'Fix login',
  request: 'The login form drops the session',
  repos: [{ path: '/repo', baseRef: null }],
  scenario: { preset: 'bug-fix' },
  launchPolicy: 'confirm',
  ciWait: false,
} as EstimateFields;

describe('launch form: to the board queue', () => {
  it('the default stop is the board one, and «at the MR» while the board has not answered', () => {
    expect(defaultStopOf(undefined)).toBe('mr');
    expect(defaultStopOf({ defaultStop: 'plan' })).toBe('plan');
    expect(STOP_CHOICES).toEqual(['plan', 'mr', 'end']);
  });

  it('the entry carries the estimate fields as is, the chosen stop and the preset', () => {
    const draft = entryDraftOf(fields, 'end');
    expect(boardEntryDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft).toMatchObject({
      stop: 'end',
      preset: 'bug-fix',
      source: { kind: 'manual', title: 'Fix login' },
      launch: { kind: 'fields', fields },
    });
  });

  it('a library scenario puts its id as the preset; a tracker snapshot keeps its key', () => {
    const library = entryDraftOf({ ...fields, scenario: { id: 'group-x', version: 2 } }, 'mr');
    expect(library.preset).toBe('group-x');
    const tracker = entryDraftOf(
      {
        ...fields,
        source: { kind: 'tracker', key: 'PROJ-7', body: 'b', fetchedAt: 1, digest: 'a'.repeat(64) },
      } as EstimateFields,
      'mr',
    );
    expect(tracker.source).toEqual({ kind: 'tracker', key: 'PROJ-7', title: 'Fix login' });
  });
});
