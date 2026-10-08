import type { PlatformToolRoute, CompromiseId } from '@agentdeck/contracts';

/**
 * Подпись у цели-CLI: чем её инструменты дойдут до модели. Полем — подписывать
 * нечего; прослойкой — работает с её оговоркой; никак — собеседник без рук.
 */
export function toolRouteMark(route: PlatformToolRoute): CompromiseId | null {
  if (route === 'native') return null;
  return route === 'shim' ? 'tool-shim' : 'no-client-tools';
}
