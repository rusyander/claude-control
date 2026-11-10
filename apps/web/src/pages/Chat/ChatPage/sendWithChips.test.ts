import { describe, expect, it } from 'vitest';
import type { ComposerChip } from '@features/ChatComposer';
import type { DraftBox } from '@shared/lib/draft';
import { sendWithChips } from './sendWithChips';

/** Отправка с чипами выбранных элементов сайта (D20): одно сообщение, отказ ничего не теряет. */
function box(initial: string): DraftBox {
  let value = initial;
  return { get: () => value, set: (next) => (value = next), subscribe: () => () => undefined };
}
function store(initial: ComposerChip[]) {
  let list: readonly ComposerChip[] = initial;
  return { list: () => list, clear: () => (list = []) };
}
const chip: ComposerChip = {
  id: 'c1',
  label: '<button> Pay',
  block: 'Элемент со страницы сайта:\n- тег: button',
};

describe('sendWithChips', () => {
  it('без чипов — обычная отправка, поле не трогается', async () => {
    const draft = box('просто текст');
    const seen: string[] = [];
    const ok = await sendWithChips(
      draft,
      [],
      async () => (seen.push(draft.get()), true),
      store([]),
    );
    expect(ok).toBe(true);
    expect(seen).toEqual(['просто текст']);
  });

  it('блоки чипов уходят с набранным одним сообщением, принятое снимает чипы', async () => {
    const draft = box('поправь кнопку');
    const chips = store([chip]);
    const seen: string[] = [];
    const ok = await sendWithChips(draft, [], async () => (seen.push(draft.get()), true), chips);
    expect(ok).toBe(true);
    expect(seen).toEqual([`поправь кнопку\n\n${chip.block}`]);
    expect(chips.list()).toEqual([]);
  });

  it('отказ: чипы остаются, в поле — набранное, а не собранный текст', async () => {
    const draft = box('поправь кнопку');
    const chips = store([chip]);
    const ok = await sendWithChips(draft, [], async () => false, chips);
    expect(ok).toBe(false);
    expect(draft.get()).toBe('поправь кнопку');
    expect(chips.list()).toEqual([chip]);
  });

  it('отказ после того, как человек начал новое, его текст не затирает', async () => {
    const draft = box('поправь кнопку');
    const ok = await sendWithChips(
      draft,
      [],
      async () => (draft.set('новое'), false),
      store([chip]),
    );
    expect(ok).toBe(false);
    expect(draft.get()).toBe('новое');
  });
});
