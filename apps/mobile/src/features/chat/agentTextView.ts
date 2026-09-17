import { scanSplitBlocks } from '@agentdeck/contracts/task-split';
import { scanHandoffBlocks } from '@agentdeck/contracts/chat-handoff';
import { scanMediaBlocks } from '@agentdeck/contracts/media-block';

/** Слова, которыми телефон говорит о блоках, которые он не показывает карточкой. */
export interface AgentTextWords {
  offerSplit: string;
  offerHandoff: string;
  offerDeck: string;
  blocksRejected: (count: number) => string;
}

/** Ответ агента, разложенный для показа на телефоне. */
export interface AgentTextView {
  /** Текст без разобранных блоков — уходит в Markdown. */
  markdown: string;
  /** Годные рисунки `agentdeck:svg`, по карточке на каждый. */
  pictures: PictureView[];
  /** Строки о том, что было в ответе, но решается в панели. */
  notes: string[];
}

export interface PictureView {
  svg: string;
  /** Ширина к высоте из `viewBox` (или `width`/`height`); нет — квадрат. */
  ratio: number;
}

/**
 * Разбор ОДИН на ленту из транскрипта и на живой поток: иначе рисунок был бы
 * карточкой после прогона и простынёй разметки, пока ответ печатается.
 *
 * Порядок тот же, что у панели: сначала предложения (разделение, продолжение),
 * потом вложения. Разбор вложений — та же функция `scanMediaBlocks`, что у
 * сервера и ленты панели, поэтому «что считать рисунком» и «что отвергнуть
 * как опасное» телефон не решает сам.
 */
export function agentTextView(
  text: string,
  words: AgentTextWords,
  options: { streaming?: boolean } = {},
): AgentTextView {
  const split = scanSplitBlocks(text);
  const handoff = scanHandoffBlocks(split.text);
  const media = scanMediaBlocks(handoff.text, { streaming: options.streaming });
  const notes = [
    ...split.proposals.map(() => words.offerSplit),
    ...handoff.proposals.map(() => words.offerHandoff),
    ...media.decks.map(() => words.offerDeck),
  ];
  // Непринятый блок остался в тексте как есть — говорим, что это решение панели,
  // а не сломанный ответ агента.
  if (media.rejected > 0) notes.push(words.blocksRejected(media.rejected));
  return {
    markdown: media.text,
    pictures: media.pictures.map((svg) => ({ svg, ratio: svgRatio(svg) })),
    notes,
  };
}

/**
 * Пропорция рисунка по корневому тегу. На телефоне у карточки нет «естественного»
 * размера, как у `<img>` в браузере: без пропорции SvgXml растянул бы картинку в
 * квадрат или сжал в полоску.
 */
export function svgRatio(svg: string): number {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(root)?.[1];
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const width = parts[2];
    const height = parts[3];
    if (parts.length === 4 && width && height && width > 0 && height > 0) return width / height;
  }
  const width = Number(/\bwidth\s*=\s*["']([\d.]+)["']/i.exec(root)?.[1]);
  const height = Number(/\bheight\s*=\s*["']([\d.]+)["']/i.exec(root)?.[1]);
  return width > 0 && height > 0 ? width / height : 1;
}
