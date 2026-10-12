import type { ChangelogText } from '@agentdeck/contracts/changelog';

/**
 * Текст на языке интерфейса. Английский в описании необязателен, а сообщения
 * коммитов — русские, поэтому недостающий перевод — не ошибка, а откат на русский.
 */
export function pickText(text: ChangelogText | undefined, language: string): string {
  if (!text) return '';
  return language.toLowerCase().startsWith('en') && text.en ? text.en : text.ru;
}
