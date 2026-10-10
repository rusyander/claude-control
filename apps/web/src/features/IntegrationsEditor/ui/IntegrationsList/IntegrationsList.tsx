import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IntegrationId } from '@agentdeck/contracts';
import { Button } from '@shared/ui/button';
import { EmptyState } from '@shared/ui/empty-state';
import { ExplainBox } from '@shared/ui/explain-box';
import { Icon } from '@shared/ui/icon';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SelectField } from '@shared/ui/select-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { useSettings } from '@entities/AppConfig';
import { INTEGRATION_IDS, readIntegrations, useIntegrations } from '@entities/Integration';
import { isIntegrationSet } from '../../model/isIntegrationSet';
import { IntegrationCard } from '../IntegrationCard/IntegrationCard';
import { DiscoveredIntegrations } from '../DiscoveredIntegrations/DiscoveredIntegrations';

/**
 * Интеграции: каждая система — своя карточка (владелец 10.10.2026).
 *
 * В списке только заведённые и те, что человек добавил сейчас: десять пустых
 * форм подряд прятали две настоящие. Остальные — в «Добавить интеграцию», а
 * то, что уже работает у агента как MCP-сервер, переносится «Найти уже
 * подключённые» без повторного ввода адреса и ключа.
 *
 * Порядок постоянный — общий порядок систем, а не порядок добавления:
 * карточки читают сверху вниз, и место кнопки не должно зависеть от того,
 * в какой последовательности их заводили.
 *
 * Сервер не ответил — говорим об этом карточкой ошибки, а не пустым списком:
 * «интеграций нет» и «панель не смогла их прочитать» — разные новости.
 */
export function IntegrationsList() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const integrations = useIntegrations();
  const [added, setAdded] = useState<IntegrationId[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);

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
  const statusOf = (id: IntegrationId) => statuses.find((item) => item.id === id);
  const shown = INTEGRATION_IDS.filter(
    (id) => added.includes(id) || isIntegrationSet(id, values, statusOf(id)),
  );
  const addable = INTEGRATION_IDS.filter((id) => !shown.includes(id));

  return (
    <Stack gap="var(--spacing-md)">
      <ExplainBox title={t('integrations.explainTitle')} text={t('integrations.explain')} />

      <Stack direction="row" align="end" gap="var(--spacing-xs)" wrap>
        {addable.length > 0 && (
          <Stack flex={1} minWidth="220px">
            <SelectField
              label={t('integrations.add.label')}
              value=""
              onChange={(value) => {
                if (value) setAdded((current) => [...current, value as IntegrationId]);
              }}
              options={[
                { value: '', label: t('integrations.add.placeholder') },
                ...addable.map((id) => ({ value: id, label: t(`integrations.card.${id}.title`) })),
              ]}
            />
          </Stack>
        )}
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="search" size={18} />}
          onClick={() => setIsDiscovering(true)}
          disabled={isDiscovering}
        >
          {t('integrations.discover.open')}
        </Button>
      </Stack>

      {isDiscovering && <DiscoveredIntegrations onClose={() => setIsDiscovering(false)} />}

      {shown.length === 0 && !isDiscovering && (
        <EmptyState
          icon="plug"
          title={t('integrations.empty.title')}
          text={t('integrations.empty.text')}
        />
      )}

      {shown.map((id) => (
        <IntegrationCard key={id} id={id} status={statusOf(id)} settings={values} />
      ))}
    </Stack>
  );
}
