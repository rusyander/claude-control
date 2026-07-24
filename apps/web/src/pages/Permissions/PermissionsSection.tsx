import { useSettings } from '@entities/AppConfig';
import { ProviderPermissionsPage } from '@pages/ProviderPermissions/ProviderPermissionsPage';
import { PermissionsPage } from './PermissionsPage';

/**
 * Раздел прав/аппрувов по активному провайдеру. Claude — прежняя богатая страница
 * (allow/deny/ask, system-права, MCP, перенос) БЕЗ изменений: роутинг по
 * провайдеру, а не переписывание. Прочие провайдеры с `permissions=ready` (Codex)
 * — форма из двух селектов (approval_policy / sandbox_mode). До загрузки настроек
 * считаем провайдера дефолтным (claude) — как в остальных гейтах.
 */
export function PermissionsSection() {
  const { data: settings } = useSettings();
  const providerId = settings?.provider ?? 'claude';

  return providerId === 'claude' ? <PermissionsPage /> : <ProviderPermissionsPage />;
}
