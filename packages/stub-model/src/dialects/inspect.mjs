/**
 * Текст реплики из поля `content` любого из протоколов: строка как есть, массив
 * частей — тексты частей (`text`, `input_text`, `output_text` несут поле `text`)
 * через перевод строки; результат инструмента и картинка текста не дают.
 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((part) =>
      typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '',
    )
    .filter(Boolean)
    .join('\n');
}
