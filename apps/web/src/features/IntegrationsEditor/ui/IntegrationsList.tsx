import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { ExplainBox } from '@shared/ui/explain-box';
import { useSettings } from '@entities/AppConfig';
import { INTEGRATION_IDS, readIntegrations, useIntegrations } from '@entities/Integration';
import { IntegrationCard } from './IntegrationCard';

/**
 * Все пять коннекторов подряд.
 *
 * Порядок постоянный: карточки читают глазами сверху вниз, и переставлять их
 * по состоянию («настроенные наверх») значит менять место кнопки под курсором
 * между двумя заходами.
 *
 * Сервер не ответил — говорим об этом карточкой ошибки, а не пустым списком:
 * «интеграций нет» и «панель не смогла их прочитать» — разные новости.
 */
export function IntegrationsList() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const integrations = useIntegrations();

  if (integrations.isLoading) return <SkeletonList rows={3} />;

  if (integrations.isError) {
    return (
      <LoadErrorCard
        title={t('integrations.loadErrorTitle')}
        text={t('integrations.loadErrorText')}
        onRetry={() => void integrations.refetch()}
      />
    );
  }

  const values = readIntegrations(settings);
  const statuses = integrations.data ?? [];

  return (
    <Stack gap="var(--spacing-md)">
      <ExplainBox title={t('integrations.explainTitle')} text={t('integrations.explain')} />

      {INTEGRATION_IDS.map((id) => (
        <IntegrationCard
          key={id}
          id={id}
          status={statuses.find((item) => item.id === id)}
          settings={values}
        />
      ))}
    </Stack>
  );
}
