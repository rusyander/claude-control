import { useSettings } from '@entities/AppConfig';
import { ProviderEnvPage } from '@pages/ProviderEnv/ProviderEnvPage';
import { EnvPage } from './EnvPage';

/**
 * Раздел переменных окружения по активному провайдеру. Claude — прежняя богатая
 * страница (источники settings/settings-local/secrets, маскирование, перенос) без
 * изменений: роутинг по провайдеру, а не переписывание. Прочие провайдеры с
 * `env=ready` (Codex) — универсальная CRUD-страница по KV-субсету. До загрузки
 * настроек считаем провайдера дефолтным (claude) — как в остальных гейтах.
 */
export function EnvSection() {
  const { data: settings } = useSettings();
  const providerId = settings?.provider ?? 'claude';

  return providerId === 'claude' ? <EnvPage /> : <ProviderEnvPage />;
}
