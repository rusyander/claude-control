import type { EndpointProfile } from '@agentdeck/contracts';

/** Заменить профиль в списке по id (не мутируя исходный массив). */
export function replaceProfile(
  profiles: EndpointProfile[],
  profile: EndpointProfile,
): EndpointProfile[] {
  return profiles.map((item) => (item.id === profile.id ? profile : item));
}
