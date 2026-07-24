import { useProviders, activeProvider } from '@entities/Provider';
import { ProviderPluginsPage } from '@pages/ProviderPlugins/ProviderPluginsPage';
import { PluginsPage } from './PluginsPage';

/**
 * Раздел плагинов по МОДЕЛИ активного провайдера, а не по его id. Моделей две:
 *
 *  - `panel` — плагины САМОЙ панели (её расширения и маркетплейсы). Открывает
 *    ПРЕЖНЯЯ страница без единого изменения — регресс-ноль;
 *  - `files` — плагины самого CLI (OpenCode: каталог файлов JS/TS + список
 *    npm-пакетов ключом `plugin` в opencode.json).
 *
 * Модель приходит с сервера (`pluginsModel`); пока данные не загружены,
 * показываем страницу панели — дефолтный провайдер claude именно такой.
 */
export function PluginsSection() {
  const { data } = useProviders();
  const model = activeProvider(data)?.pluginsModel ?? 'panel';

  if (model === 'files') return <ProviderPluginsPage />;
  return <PluginsPage />;
}
