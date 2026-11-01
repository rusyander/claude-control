import { describe, expect, it } from 'vitest';
import { basePinDetail, parseBasePin } from './base-pin.ts';

/**
 * Строка `signal base-pin`: ссылка и sha читаются обратно ровно такими, какими записаны (заметка
 * о локальной базе не мешает); текст не той формы — `null`, а не догадка о ветке.
 */

const SHA = 'a'.repeat(40);

describe('base-pin detail', () => {
  it.each([
    ['origin/main', null],
    ['origin/agentdeck/1a2b3c4d', 'fetch failed: offline, local ref used'],
    ['refs/remotes/upstream/release-1.2', 'note: with: colons'],
  ])('%s round-trips (note %s)', (ref, note) => {
    expect(parseBasePin(basePinDetail(ref, SHA, note))).toEqual({ ref, sha: SHA });
  });

  it.each(['', 'origin/main', `origin/main ${SHA} extra`, `: origin/main ${SHA}`])(
    'malformed %j is null',
    (detail) => {
      expect(parseBasePin(detail)).toBeNull();
    },
  );
});
