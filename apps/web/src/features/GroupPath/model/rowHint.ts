import type { RowText } from './describe.types';
import { firstParagraph } from './firstParagraph';

/** Короткое описание — для подсказки строки: первый абзац того же текста. */
export function rowHint(text: RowText): RowText {
  return text.kind === 'text' ? { kind: 'text', text: firstParagraph(text.text) } : text;
}
