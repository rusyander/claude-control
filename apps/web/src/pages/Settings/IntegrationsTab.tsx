import { IntegrationsList } from '@features/IntegrationsEditor';

/**
 * Раздел «Интеграции»: пять коннекторов к внешнему миру.
 *
 * Тонкая обёртка — вся работа в фиче: тот же список пригодится где угодно ещё,
 * а страница настроек знает только, в какой вкладке он живёт.
 */
export function IntegrationsTab() {
  return <IntegrationsList />;
}
