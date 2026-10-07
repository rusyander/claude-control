import { useProviders, activeProvider } from '@entities/Provider';
import { ProviderRulesPage } from '@pages/ProviderRules/ProviderRulesPage';
import { RulesPage } from './RulesPage';

/**
 * Раздел правил по МОДЕЛИ активного провайдера (MAP 24), а не по его id:
 *
 *  - `claude` — богатый раздел правил Claude. Открывает ПРЕЖНЯЯ страница без
 *    единого изменения — регресс-ноль;
 *  - `files` — каталог правил самого CLI рядом с его инструкциями (Qwen Code:
 *    `~/.qwen/rules/*.md`). Та же страница, что у Cursor, в форме своего формата.
 *
 * Пока список провайдеров не загружен, показываем страницу Claude — дефолтный
 * провайдер именно такой.
 */
export function RulesSection() {
  const { data } = useProviders();
  const model = activeProvider(data)?.rulesModel ?? 'claude';

  if (model === 'files') return <ProviderRulesPage />;
  return <RulesPage />;
}
