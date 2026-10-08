import type { EnvVar } from '@agentdeck/contracts';

/**
 * Подсказки поля значения секрета (ключи i18n). Пустой секрет — его сохранил
 * агент панели и открыл форму, чтобы значение ввёл человек: «значение скрыто»
 * и «оставьте пустым» говорили бы, что оно уже есть, и форму закрывали бы ни с чем.
 */
export function secretValueHints(
  envVar: EnvVar | undefined,
): { placeholder: string; hint: string } | undefined {
  if (!envVar?.isSecret) return undefined;
  return envVar.value === ''
    ? { placeholder: 'env.secretEmpty', hint: 'env.secretEmptyHint' }
    : { placeholder: 'env.secretHidden', hint: 'env.secretRewrite' };
}
