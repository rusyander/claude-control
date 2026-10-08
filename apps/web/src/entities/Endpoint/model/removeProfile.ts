import type { EndpointProfile } from '@agentdeck/contracts';

/** Убрать профиль из списка по id. */
export function removeProfile(profiles: EndpointProfile[], id: string): EndpointProfile[] {
  return profiles.filter((item) => item.id !== id);
}
