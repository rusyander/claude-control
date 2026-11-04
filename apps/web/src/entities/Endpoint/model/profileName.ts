import type { EndpointProfile } from '@agentdeck/contracts';
import { serverMessageText } from '@shared/config/i18n';

/**
 * Имя профиля для показа.
 *
 * Профиль контура хранит только название контура, данное человеком; приставку
 * «Контур ·» дописывает экран кодом `contour-profile-name` на своём языке —
 * русская приставка в хранимом имени читалась бы и под английским интерфейсом.
 * Профиль человека показывается его именем как есть.
 */
export function endpointProfileName(
  profile: Pick<EndpointProfile, 'name' | 'ownerPlatformId'>,
): string {
  if (!profile.ownerPlatformId) return profile.name;
  return serverMessageText('contour-profile-name', { title: profile.name }) ?? profile.name;
}
