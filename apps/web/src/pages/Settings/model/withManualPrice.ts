import type { ModelPricing } from '@agentdeck/contracts';

/**
 * Свои цены после добавления ручной. Имя — строчными и без пробелов по краям:
 * расчёт сверяет фрагмент с именем модели без учёта регистра, и «Qwen3.8 » с
 * пробелом не совпал бы ни с чем. Пустое имя — `undefined`, а не цена на всё.
 */
export function withManualPrice(
  custom: Record<string, ModelPricing>,
  model: string,
  price: ModelPricing,
): Record<string, ModelPricing> | undefined {
  const key = model.trim().toLowerCase();
  if (!key) return undefined;
  return { ...custom, [key]: price };
}
