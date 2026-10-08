import type { Platform, PlatformHealthRecord } from '@agentdeck/contracts';
import type { PlatformModelSource } from '@agentdeck/contracts/platform-models';
import { catalogDefaultModel } from '@agentdeck/contracts/platform-models';

/**
 * Модель контура и откуда она взялась — тот же порядок, что на сервере
 * (`defaultModelOf`), но по данным карточки: выбор человека, иначе первая
 * чатовая модель каталога.
 *
 * Слабее серверной ровно в одном: модель, оставшуюся в управляемом профиле от
 * прежнего применения, карточка не видит. Поэтому она НИКОГДА не называет
 * выбором то, чего человек не выбирал, — худшее, что здесь бывает, это
 * «первая из каталога» там, где на самом деле уедет модель профиля.
 */
export function cardModel(
  platform: Platform,
  health: PlatformHealthRecord | undefined,
): { model: string; source: PlatformModelSource } {
  const chosen = platform.defaultModel.trim();
  if (chosen) return { model: chosen, source: 'default' };
  const first = catalogDefaultModel(health?.models ?? [])?.id;
  return first ? { model: first, source: 'catalog' } : { model: '', source: 'none' };
}
