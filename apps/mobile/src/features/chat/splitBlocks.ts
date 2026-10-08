/**
 * Разметка ответа агента. Не полный markdown и не притворяется им: на экране
 * шириной в 390 точек ценность имеют ровно три вещи — блоки кода отдельно от
 * текста, моноширинный инлайн и жирные заголовки списков. Остальное (таблицы,
 * ссылки, вложенные цитаты) на телефоне всё равно нечитаемо, а тащить ради него
 * парсер с деревом узлов — платить размером бандла за то, чем не пользуются.
 *
 * Панель в браузере рисует полный markdown (markdown-it) — это осознанная
 * разница носителей, а не отставание.
 */

export interface Block {
  kind: 'text' | 'code';
  content: string;
  /** Язык из ограды ```ts — показывается подписью над блоком. */
  lang?: string;
}

/** Разбить текст на блоки кода и всё остальное. */
export function splitBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const pattern = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      blocks.push({ kind: 'text', content: source.slice(cursor, match.index) });
    }
    blocks.push({ kind: 'code', content: match[2] ?? '', lang: match[1] || undefined });
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) blocks.push({ kind: 'text', content: source.slice(cursor) });
  return blocks.filter((block) => block.content.trim().length > 0);
}
