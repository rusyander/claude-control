import { describe, expect, it } from 'vitest';
import type { PathEntry, PathStep } from '@agentdeck/contracts';
import { buildPathRows } from './pathRows';
import { buildLayout } from './layout';
import { insertAfter } from './insertAfter';
import { rowType } from './rowType';
import { skillBlockType } from './skillBlockType';
import type { SourceContext } from './stepSource.types';
import { entrySource } from './entrySource';

const context: SourceContext = {
  group: { scope: undefined, members: [] } as unknown as SourceContext['group'],
  ourSkills: new Set(['ship']),
};

describe('вид блока скилла — по скиллу, а не по первой строке (F-273)', () => {
  it('свой шаг первым в блоке («+» сразу после стадии работы) не делает блок «промптом»', () => {
    const entries: PathEntry[] = [
      { kind: 'builtin', stage: 'work' } as PathEntry,
      { kind: 'skill-step', skillId: 'ship', index: 0, title: 'Branch' },
      { kind: 'skill-step', skillId: 'ship', index: 1, title: 'Review' },
    ];
    const step = {
      id: 'p1',
      anchor: 'work',
      order: 0,
      kind: 'prompt',
      title: { ru: 'x', en: 'x' },
      prompt: { ru: 'x', en: 'x' },
      source: 'ru',
      createdAt: '',
    } as PathStep;
    const [placed] = insertAfter(entries, 0, step);
    // Сервер ставит шаг `within index -1` перед первым шагом скилла.
    const after = [
      entries[0],
      { kind: 'custom', step: placed },
      entries[1],
      entries[2],
    ] as PathEntry[];
    const block = buildLayout(
      buildPathRows(after, [], () => undefined),
      'conveyor',
    ).find((item) => item.kind === 'block');
    const first = block?.kind === 'block' ? block.items[0]?.row : undefined;
    // Первая строка — свой промпт: вид по ней и давал «промпт» на чипе блока.
    expect(first?.kind === 'entry' && rowType(entrySource(first.entry, context))).toBe('prompt');
    expect(skillBlockType('ship', context)).toBe('our-skill');
  });
});
