import { describe, expect, it } from 'vitest';
import { scanReviewBlocks } from '@agentdeck/contracts/model-cascade';
import { localizeText, serverText } from './server-texts.ts';

/**
 * Пробел доставки «вердикта ревьюера нет» без лекарства (g5 25.10, P1): ведущий две минуты
 * искал в коде панели, каким блоком снимается пробел. Текст называет блок и место, и блок,
 * собранный ровно по тексту, принимает тот же разборщик, что читает вердикт ответа ревью.
 */
describe('delivery-gap-review-unfinished: пробел называет блок вердикта и куда его писать', () => {
  for (const language of ['ru', 'en'] as const) {
    it(`${language}: блок из текста разбирается как вердикт ревью`, () => {
      const text = localizeText(serverText('delivery-gap-review-unfinished'), language);
      const tag = /```([\w:-]+)```/.exec(text)?.[1];
      const body = /(\{"findings":\[)…(\]\})/.exec(text);
      expect(tag).toBe('agentdeck:review');
      expect(body).not.toBeNull();
      expect(text).toMatch(
        language === 'ru' ? /последний ответ этапа ревью/ : /final answer of the review stage/,
      );
      const answer = `Готово.\n\n\`\`\`${tag}\n${body?.[1]}${body?.[2]}\n\`\`\``;
      expect(scanReviewBlocks(answer).findings).toEqual([]);
    });
  }
});
