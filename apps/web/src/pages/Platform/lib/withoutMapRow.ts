import type { Platform } from '@agentdeck/contracts';

export function withoutMapRow(platform: Platform, from: string): Platform {
  const next = { ...platform.modelMap };
  delete next[from];
  return { ...platform, modelMap: next };
}
