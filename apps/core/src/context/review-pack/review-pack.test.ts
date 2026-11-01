import { describe, expect, it } from 'vitest';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { reviewInputsOf, reviewPack } from './review-pack.ts';
import type { PackFile, ReviewPackInput } from './review-pack.types.ts';

/**
 * Пакет ревью (03 §Context): дифф единицы против базы, требования, записи проверок; сверх предела —
 * список файлов и `unit_diff(file)`; lock-файл без тела; разговора автора нет; маска выхода.
 */

const file = (path: string, diff: string | null, added = 1, deleted = 0): PackFile => ({
  path,
  added,
  deleted,
  binary: false,
  diff,
});

const input = (files: PackFile[], capBytes?: number): ReviewPackInput => ({
  unitId: 'u1',
  baseRef: 'main',
  files,
  requirements: [{ id: 'r-1', ordinal: 1, text: 'hello.txt says hello', verdict: 'unknown' }],
  records: [{ checkId: 'unit', unit: 'pkg', state: 'recorded', recordId: 'rec-1' }],
  ...(capBytes !== undefined ? { capBytes } : {}),
});

describe('reviewPack', () => {
  it('under the cap: bodies inline, requirements and records summarised', () => {
    const pack = reviewPack(input([file('hello.txt', '+hello')]));
    expect(pack.mode).toBe('inline');
    expect(pack.text).toContain('### hello.txt\n+hello');
    expect(pack.text).toContain('- R1 [unknown] id r-1: hello.txt says hello');
    expect(pack.text).toContain('- unit on pkg: recorded (record rec-1)');
    expect(pack.sections.map((s) => s.id)).toEqual([
      'review-pack:diff',
      'review-pack:requirements',
      'review-pack:records',
    ]);
  });

  it('over the cap: file list and the unit_diff instruction, no body at all (no silent cut)', () => {
    const big = `+${'x'.repeat(500)}`;
    const pack = reviewPack(input([file('a.ts', big, 1), file('b.ts', big, 1)], 600));
    expect(pack.mode).toBe('file-list');
    expect(pack.text).toContain('- a.ts +1 -0');
    expect(pack.text).toContain('call unit_diff with {"file": "<path>"}');
    expect(pack.text).not.toContain('x'.repeat(100));
  });

  it('a lock file is named without its body; an untracked file is named as read-in-copy', () => {
    const pack = reviewPack(
      input([file('pnpm-lock.yaml', '+lots of lock'), file('new.txt', null)]),
    );
    expect(pack.text).toContain('pnpm-lock.yaml +1 -0 — lock file, body left out');
    expect(pack.text).not.toContain('lots of lock');
    expect(pack.text).toContain('new.txt +1 -0 — no git body');
  });

  it('a secret planted in the diff never reaches the pack', () => {
    const key = `glpat-${'c'.repeat(20)}`;
    const pack = reviewPack(input([file('.env', `+TOKEN=${key}`)]));
    expect(pack.text).not.toContain(key);
    expect(pack.masked).toBeGreaterThan(0);
  });
});

describe('reviewInputsOf — never the author conversation', () => {
  it('takes requirements and the unit records only; the claim text of the author is not read', () => {
    const state = {
      requirements: {
        'r-1': { ordinal: 1, text: 'say hello', source: 'task', verdict: 'met', evidence: [] },
      },
      steps: {
        s1: {
          state: 'done',
          unitId: 'u1',
          stepKind: 'work',
          claim: { seq: 9, call: { summary: 'AUTHOR_CONVERSATION_MARKER I did it' } },
        },
        s2: { state: 'done', unitId: 'u2', stepKind: 'work' },
      },
      checks: {
        c1: {
          state: 'recorded',
          recordId: 'rec-1',
          run: { checkId: 'unit', unit: 'pkg', stepId: 's1' },
        },
        c2: {
          state: 'recorded',
          recordId: 'rec-2',
          run: { checkId: 'unit', unit: 'pkg', stepId: 's2' },
        },
      },
    } as unknown as Pick<TaskFoldState, 'requirements' | 'checks' | 'steps'>;
    const got = reviewInputsOf(state, 'u1');
    expect(got.requirements).toEqual([
      { id: 'r-1', ordinal: 1, text: 'say hello', verdict: 'met' },
    ]);
    expect(got.records).toEqual([
      { checkId: 'unit', unit: 'pkg', state: 'recorded', recordId: 'rec-1' },
    ]);
    const pack = reviewPack({ unitId: 'u1', baseRef: 'main', files: [], ...got });
    expect(pack.text).not.toContain('AUTHOR_CONVERSATION_MARKER');
  });
});
