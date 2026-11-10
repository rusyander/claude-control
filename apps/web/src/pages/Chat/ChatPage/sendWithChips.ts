import type { ComposerChip } from '@features/ChatComposer';
import { withChipBlocks } from '@features/ChatComposer';
import type { DraftBox } from '@shared/lib/draft';
import type { ChipSendDeps } from './sendWithChips.types';

/**
 * Отправка с чипами описаний (выбранный элемент сайта, D20): блоки чипов дописываются к
 * набранному одним сообщением, и уходит оно обычной дорогой поля ввода. Принято — чипы сняты.
 * Отказ — чипы остаются, а в поле возвращается набранное человеком, а не собранный текст с
 * блоками (если он за это время не начал писать новое).
 */
export async function sendWithChips<F>(
  draft: DraftBox,
  files: F[],
  send: (files: F[]) => Promise<boolean>,
  { list, clear }: ChipSendDeps,
): Promise<boolean> {
  const chips: readonly ComposerChip[] = list();
  if (chips.length === 0) return send(files);
  const typed = draft.get();
  const composed = withChipBlocks(typed, chips);
  draft.set(composed);
  const accepted = await send(files);
  if (accepted) clear();
  else if (draft.get() === composed) draft.set(typed);
  return accepted;
}
