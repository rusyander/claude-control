import type { IntegrationLink } from '@agentdeck/contracts';

/**
 * Тело для сохранения: пустые строки выбрасываются, чтобы «стёр поле» и
 * «никогда не заполнял» лежали на диске одинаково, а не двумя разными формами
 * одного и того же.
 */
export function cleanLink(link: IntegrationLink): IntegrationLink {
  const result: IntegrationLink = {};
  for (const [key, value] of Object.entries(link)) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) (result as Record<string, string>)[key] = text;
  }
  return result;
}
