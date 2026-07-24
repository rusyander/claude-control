import { useSettings } from '@entities/AppConfig';
import { ProviderMcpPage } from '@pages/ProviderMcp/ProviderMcpPage';
import { McpPage } from './McpPage';

/**
 * Раздел MCP по активному провайдеру. Claude — прежняя богатая страница
 * (OAuth, инструменты, проверка связи, группы) без изменений: роутинг по
 * провайдеру, а не переписывание. Прочие провайдеры с `mcp=ready` (Gemini/Codex)
 * — универсальная CRUD-страница по переносимому субсету. До загрузки настроек
 * считаем провайдера дефолтным (claude) — как в остальных гейтах.
 */
export function McpSection() {
  const { data: settings } = useSettings();
  const providerId = settings?.provider ?? 'claude';

  return providerId === 'claude' ? <McpPage /> : <ProviderMcpPage />;
}
