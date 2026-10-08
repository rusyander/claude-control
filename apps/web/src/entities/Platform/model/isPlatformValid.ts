import type { Platform } from '@agentdeck/contracts';
import { validatePlatform } from './validatePlatform';

/** Готов ли черновик к сохранению — та же проверка, что и на сервере. */
export function isPlatformValid(draft: Platform): boolean {
  return Object.keys(validatePlatform(draft)).length === 0;
}
