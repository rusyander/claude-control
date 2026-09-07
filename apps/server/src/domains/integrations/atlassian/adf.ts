/**
 * ADF — формат документов облачной Jira (Atlassian Document Format).
 *
 * Своей установке всё это не нужно: там описание и комментарий — обычный текст.
 * Но у облака поле `description` типизировано документом, и строка в нём даёт
 * 400 «Operation value must be an Atlassian Document». Поэтому туда текст
 * заворачивается, а обратно разворачивается — панель и агент работают со
 * строками, а не с деревом узлов.
 *
 * Разворачивание НАМЕРЕННО грубое: нужен читаемый текст задачи, а не точная
 * обратная конвертация. Списки, таблицы и панели превращаются в строки — это
 * ровно то, что человек и агент читают глазами.
 */

export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  /** Есть только у корня документа; без неё облако отвечает 400. */
  version?: number;
}

/** Текст → документ ADF. Пустые строки становятся отдельными абзацами. */
export function toAdf(text: string): AdfNode {
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\r?\n/).map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

/**
 * Документ ADF (или уже готовая строка) → плоский текст. `undefined` остаётся
 * `undefined`: «поля нет» и «поле пустое» — разные вещи для карточки задачи.
 */
export function fromAdf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);

  const lines: string[] = [];
  collect(value as AdfNode, lines);
  return lines.join('\n').trim();
}

/** Обход дерева: узлы блочного уровня начинают новую строку, текст — дописывает. */
function collect(node: AdfNode, lines: string[]): void {
  if (node.type === 'text' && typeof node.text === 'string') {
    if (lines.length === 0) lines.push('');
    lines[lines.length - 1] += node.text;
    return;
  }
  if (node.type === 'hardBreak') {
    lines.push('');
    return;
  }

  const block =
    node.type === 'paragraph' ||
    node.type === 'heading' ||
    node.type === 'listItem' ||
    node.type === 'codeBlock' ||
    node.type === 'blockquote';
  if (block) lines.push('');

  for (const child of node.content ?? []) collect(child, lines);
}
