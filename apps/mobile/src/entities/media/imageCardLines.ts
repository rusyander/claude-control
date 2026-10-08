import type { MediaImage } from '@agentdeck/contracts';
import type { Words } from './mode.types';
import { formatBytes } from './formatBytes';

/** Подпись карточки: кто нарисовал и какой размер. */
export function imageCardLines(image: MediaImage, words: Words): string[] {
  const source = words.card.source[image.source];
  const lines = [image.model ? words.card.by(image.model, source) : words.card.byNoModel(source)];
  const size = formatBytes(image.sizeBytes);
  lines.push(image.width && image.height ? words.card.size(image.width, image.height, size) : size);
  return lines;
}
