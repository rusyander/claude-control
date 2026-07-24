import { useProviders, activeProvider } from '@entities/Provider';
import { ProviderHooksPage } from '@pages/ProviderHooks/ProviderHooksPage';
import { HooksPage } from './HooksPage';

/**
 * Раздел хуков по МОДЕЛИ активного провайдера, а не по его id. Моделей две:
 *
 *  - `claude` — богатые хуки Claude (события `PreToolUse`/`PostToolUse` с
 *    матчерами и shell-командами в settings.json). Открывает ПРЕЖНЯЯ страница
 *    без единого изменения — регресс-ноль;
 *  - `config` — хуки ключом конфига CLI (OpenCode: `experimental.hook` в
 *    opencode.json, два события, действия-argv).
 *
 * Модель приходит с сервера (`hooksModel`); пока данные не загружены,
 * показываем claude-страницу — дефолтный провайдер именно такой.
 */
export function HooksSection() {
  const { data } = useProviders();
  const model = activeProvider(data)?.hooksModel ?? 'claude';

  if (model === 'config') return <ProviderHooksPage />;
  return <HooksPage />;
}
