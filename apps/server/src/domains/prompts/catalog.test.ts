import { describe, expect, it } from 'vitest';
import {
  checkPicture,
  pictureBlockRequest,
  scanMediaBlocks,
} from '@agentdeck/contracts/media-block';
import { builtinPromptText } from './catalog.ts';

/**
 * Промпт рисунка кодом обещает модели ровно то, что панель принимает.
 *
 * Проверяются не слова в тексте, а два места, где расхождение стоит человеку
 * отказа, который он не может починить: пример внутри промпта проходит ТУ ЖЕ
 * проверку, что и ответ агента (`checkPicture`), а готовая просьба не содержит
 * блока, который лента вырезала бы из сообщения человека и показала карточкой —
 * `scanMediaBlocks` разбирает и его пузырь, не только ответ агента. Поэтому
 * пример дан отступом, а не забором, и это здесь тоже утверждение, а не стиль.
 */

/** Пример из промпта: он дан отступом в четыре пробела — берём именно его. */
function exampleSvg(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^ {4}<svg[\s>]/.test(line));
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index >= start && /^ {4}<\/svg>\s*$/.test(line));
  if (end < 0) return '';
  return lines
    .slice(start, end + 1)
    .map((line) => line.slice(4))
    .join('\n');
}

describe('промпт рисунка кодом', () => {
  it('пример внутри промпта панель приняла бы как рисунок', () => {
    const svg = exampleSvg(builtinPromptText('image-svg'));

    // Пусто — значит примера нет или он перестал быть отступом: и то и другое
    // ломает промпт молча, поэтому проверка стоит до разбора.
    expect(svg).not.toBe('');
    expect(checkPicture(svg)).toEqual({ svg });
  });

  it('готовая просьба не несёт блока, который лента приняла бы за рисунок', () => {
    const request = pictureBlockRequest(builtinPromptText('image-svg'), 'схема шлюза');
    const scan = scanMediaBlocks(request);

    expect(scan.pictures).toEqual([]);
    expect(scan.rejected).toBe(0);
    // Текст просьбы доезжает целиком: пример остаётся на виду у модели.
    expect(scan.text).toContain('<title>Заявка проходит проверку</title>');
  });
});
