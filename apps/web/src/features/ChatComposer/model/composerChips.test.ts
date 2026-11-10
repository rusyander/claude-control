import { afterEach, describe, expect, it } from 'vitest';
import { COMPOSER_CHIPS_MAX, composerChips, withChipBlocks } from './composerChips';
import type { ComposerChip } from './composerChips.types';

/** Чипы описаний в поле ввода (выбранный элемент сайта, P174): хранилище и сборка сообщения. */
const chip = (id: string): ComposerChip => ({ id, label: id, block: `блок ${id}` });

afterEach(() => composerChips.clear());

describe('composerChips', () => {
  it('тот же элемент не дублируется, подписчик узнаёт о каждой перемене', () => {
    let calls = 0;
    const off = composerChips.subscribe(() => (calls += 1));
    composerChips.add(chip('a'));
    composerChips.add(chip('a'));
    composerChips.add(chip('b'));
    composerChips.remove('a');
    off();
    composerChips.add(chip('c'));
    expect(composerChips.list().map((c) => c.id)).toEqual(['b', 'c']);
    expect(calls).toBe(4);
  });

  it('сверх предела уходит самый старый', () => {
    for (let i = 0; i <= COMPOSER_CHIPS_MAX; i++) composerChips.add(chip(`c${i}`));
    const ids = composerChips.list().map((c) => c.id);
    expect(ids).toHaveLength(COMPOSER_CHIPS_MAX);
    expect(ids[0]).toBe('c1');
  });
});

describe('withChipBlocks', () => {
  it('просьба первой, блоки — отдельными абзацами; без чипов текст как есть', () => {
    expect(withChipBlocks('текст  \n', [chip('a'), chip('b')])).toBe('текст\n\nблок a\n\nблок b');
    expect(withChipBlocks('текст  ', [])).toBe('текст  ');
  });
});
