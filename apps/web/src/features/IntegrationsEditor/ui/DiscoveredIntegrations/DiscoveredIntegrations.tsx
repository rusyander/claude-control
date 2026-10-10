import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useApplyDiscovered, useIntegrationDiscovery } from '@entities/Integration';
import { defaultSelection, doubledIntegration } from '../../model/discoverySelection';
import { DiscoveredItem } from '../DiscoveredItem/DiscoveredItem';
import type { DiscoveredIntegrationsProps } from './DiscoveredIntegrations.types';

/**
 * «Найти уже подключённые»: интеграции среди MCP-серверов человека и
 * подтверждение переноса.
 *
 * Ничего не переносится без галочки: находка — это чужая конфигурация, и
 * человек должен увидеть, ЧТО именно ляжет в карточку (адрес, почта, маска
 * ключа) и что из сохранённого будет заменено. Два сервера на одну систему
 * называются до запроса — сервер отказал бы целиком, не записав ничего.
 */
export function DiscoveredIntegrations({ onClose }: DiscoveredIntegrationsProps) {
  const { t } = useTranslation();
  const discovery = useIntegrationDiscovery(true);
  const apply = useApplyDiscovered();
  const found = discovery.data?.found;
  const [selected, setSelected] = useState<string[]>([]);

  // Отметки по умолчанию — когда пришёл ответ, и заново после каждого поиска:
  // ключ находки, исчезнувшей из конфигурации, отмеченным оставаться не должен.
  useEffect(() => {
    setSelected(found ? defaultSelection(found) : []);
  }, [found]);

  const toggle = (key: string): void => {
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  const doubled = found ? doubledIntegration(found, selected) : undefined;

  const transfer = (): void => {
    apply.mutate(selected, { onSuccess: onClose });
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-xs)" wrap>
          <Typography variant="body" weight="medium" as="h3">
            {t('integrations.discover.title')}
          </Typography>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="close" size={18} />}
            onClick={onClose}
          >
            {t('integrations.discover.close')}
          </Button>
        </Stack>

        <Typography variant="body-sm" color="subtle" className="prose">
          {t('integrations.discover.explain')}
        </Typography>

        {discovery.isLoading && <SkeletonList rows={2} />}

        {discovery.isError && (
          <LoadErrorCard
            title={t('integrations.loadErrorTitle')}
            text={t('integrations.loadErrorText')}
            onRetry={() => void discovery.refetch()}
          />
        )}

        {found && found.length === 0 && (
          <Typography variant="body-sm" color="subtle">
            {t('integrations.discover.nothing', { count: discovery.data?.scanned ?? 0 })}
          </Typography>
        )}

        {found && found.length > 0 && (
          <>
            <Stack gap="var(--spacing-xs)">
              {found.map((item) => (
                <DiscoveredItem
                  key={item.key}
                  item={item}
                  isSelected={selected.includes(item.key)}
                  onToggle={() => toggle(item.key)}
                />
              ))}
            </Stack>

            {doubled && (
              <Typography variant="caption" color="warning">
                {t('integrations.discover.twice', {
                  name: t(`integrations.card.${doubled}.title`),
                })}
              </Typography>
            )}

            <Stack direction="row" gap="var(--spacing-xs)" wrap>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Icon name="check" size={18} />}
                onClick={transfer}
                disabled={selected.length === 0 || Boolean(doubled)}
                isLoading={apply.isPending}
              >
                {t('integrations.discover.apply', { count: selected.length })}
              </Button>
            </Stack>
          </>
        )}
      </Stack>
    </Card>
  );
}
