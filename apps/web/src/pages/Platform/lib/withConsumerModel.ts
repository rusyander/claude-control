import type { Platform } from '@agentdeck/contracts';

/**
 * Переопределение модели потребителя. Пустое значение УДАЛЯЕТ строку, а не
 * пишет пустоту: пустая строка в словаре читалась бы как «модели нет», и
 * прогон ушёл бы без модели вовсе.
 */
export function withConsumerModel(platform: Platform, consumer: string, model: string): Platform {
  const next = { ...platform.consumerModels };
  if (model.trim()) next[consumer] = model.trim();
  else delete next[consumer];
  return { ...platform, consumerModels: next };
}
