import { describe, it, expect } from 'vitest';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import { WORK_HABITS_NOTE, WORK_HABITS_SHARED_NOTE, groupRunProfile } from './group-profile.ts';

/**
 * @covers group-profile.ts — `WORK_HABITS_NOTE`, `WORK_HABITS_SHARED_NOTE`
 * @scenario строку привычек разделили на общую часть (её получают и группы чужих
 *   CLI) и фразу про `cd` для Claude; строка Claude обязана остаться байт в байт
 *   прежней — она в системном промпте каждой группы, и любой байт сменил бы
 *   начало запроса и сбросил кэш всех тёплых сессий.
 */

/** Строка до разделения (коммит 581d21e5), дословно. */
const BEFORE =
  'Economy (the human enabled it in the panel; every call re-sends this whole conversation): ' +
  'put independent reads and commands into one step — parallel tool calls or one `a; b; c` ' +
  'command — instead of a chain of single calls; read only what you will edit or judge. Keep ' +
  'output narrow: grep, line ranges, `git diff --stat` before a full diff. Work from the copy ' +
  'root with relative paths; do not `cd` — every directory change adds an environment note to ' +
  'the conversation.';

describe('group-profile', () => {
  it('claude habits note byte-identical', () => {
    expect(Buffer.from(WORK_HABITS_NOTE, 'utf8').equals(Buffer.from(BEFORE, 'utf8'))).toBe(true);
    const run = groupRunProfile({
      entries: [],
      tasksText: '',
      extra: [],
      economy: { ...GROUP_ECONOMY_DEFAULTS, workHabits: true },
    });
    expect(run.note?.split(BEFORE)).toHaveLength(2);
  });

  it('общая часть — начало строки Claude, без `cd`', () => {
    expect(BEFORE.startsWith(`${WORK_HABITS_SHARED_NOTE} `)).toBe(true);
    expect(WORK_HABITS_SHARED_NOTE).not.toContain('cd');
  });
});
