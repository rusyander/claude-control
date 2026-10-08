import type { ProviderEditsWhenOff } from '@agentdeck/contracts';
import type { ConfigProvider } from '../types/types.ts';

/**
 * Что значит ВЫКЛЮЧЕННЫЙ «Разрешить правки» у этого CLI. Нет ответа — переключатель
 * до CLI не доходит вовсе, и клиент его не показывает (решают настройки CLI).
 * - `ask` — у CLI есть живой или сессионный сервер (opencode serve): его просьбы
 *   о записи панель показывает карточкой человеку (`live/permission.ts`);
 * - `deny` — только одиночный запуск: флаг закрывает запись, спросить некого
 *   (gemini `--approval-mode default`, aider `--dry-run`, continue `--exclude`).
 */
export function providerEditsWhenOff(provider: ConfigProvider): ProviderEditsWhenOff | undefined {
  const assistant = provider.assistant;
  if (assistant?.liveServer || assistant?.sessionServer) return 'ask';
  if ((assistant?.editsControl ?? 'none') === 'none') return undefined;
  return 'deny';
}
