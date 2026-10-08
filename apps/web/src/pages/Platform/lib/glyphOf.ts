import type { PlatformApplyTarget, PlatformToolRoute } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts';

/**
 * Значок — быстрый признак; смысл несёт слово рядом и подпись для скринридера.
 * CLI полноценен, только когда инструменты доходят полем: прослойка работает с
 * оговоркой, а без инструментов CLI — собеседник.
 */
export function glyphOf(target: PlatformApplyTarget, route: PlatformToolRoute): string {
  if (!target.supported) return '—';
  if (!target.applied) return '○';
  if (target.targetId === PLATFORM_ASSISTANT_TARGET) return '✔';
  return route === 'native' ? '✔' : '⚠';
}
