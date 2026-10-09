import { describe, expect, it } from 'vitest';
import { continueUnenforced } from './continueUnenforced';

describe('continueUnenforced', () => {
  it('уточнение у Read, Write и List cn не применяет — правило названо', () => {
    expect(
      continueUnenforced(['Read(.env)', 'Write(src/**)', 'List( docs )', 'Read (secret.txt)']),
    ).toEqual(['Read(.env)', 'Write(src/**)', 'List( docs )', 'Read (secret.txt)']);
  });

  it('инструмент целиком, (*) и сверяемые уточнения не названы', () => {
    expect(
      continueUnenforced([
        'Read',
        'Read(*)',
        'Write()',
        'Bash(git push)',
        'Edit(a.ts)',
        'Fetch(*)',
      ]),
    ).toEqual([]);
  });
});
