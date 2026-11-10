import type { PickPayload } from '@agentdeck/contracts/site-preview';
import type { PickDescription, PickLabels } from './pickBlock.types';

/** Ограда кода длиннее любой серии обратных кавычек в разметке: сайт её не закроет. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

/** Строка в одну линию: перевод строки в тексте элемента не ломает список полей. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Описание выбранного элемента (D20): подпись чипа в поле ввода и блок, который уходит агенту
 * вместе с сообщением. Текст и разметка приходят уже маскированными сервером; здесь их только
 * раскладывают по полям — селектор, тег, текст, место, адрес, разметка в ограде.
 */
export function describePick(pick: PickPayload, labels: PickLabels): PickDescription {
  const text = oneLine(pick.text);
  const { x, y, width, height } = pick.rect;
  const round = (n: number): number => Math.round(n);
  const fence = fenceFor(pick.outerHTML);
  const block = [
    labels.header,
    `- ${labels.url}: ${pick.url}`,
    `- ${labels.selector}: ${pick.selector}`,
    `- ${labels.tag}: ${pick.tag}`,
    `- ${labels.text}: ${text || labels.empty}`,
    `- ${labels.rect}: x=${round(x)} y=${round(y)} ${round(width)}×${round(height)}`,
    `- ${labels.html}:`,
    `${fence}html`,
    pick.outerHTML,
    fence,
  ].join('\n');
  const short = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return {
    label: short ? `<${pick.tag}> ${short}` : `<${pick.tag}>`,
    title: pick.selector,
    block,
  };
}
