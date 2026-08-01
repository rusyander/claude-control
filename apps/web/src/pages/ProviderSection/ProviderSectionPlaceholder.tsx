import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { PageHeader } from '@shared/ui/page-header';
import { EmptyState } from '@shared/ui/empty-state';
import { NAV_ITEMS } from '@shared/config/navigation';
import type { ProviderSectionPlaceholderProps } from './ProviderSectionPlaceholder.types';

/**
 * Заглушка раздела для не-Claude провайдера.
 *
 * Показывается вместо настоящей страницы, когда возможность у активного
 * провайдера ещё не реализована (`planned`) или отсутствует (`unsupported` при
 * заходе по прямой ссылке — из навигации такие разделы скрыты). Ключевое:
 * компонент НИЧЕГО не читает и не пишет — только `useTranslation`. Так
 * соблюдается fail-closed: пока адаптера нет, панель не трогает чужой конфиг.
 */
export function ProviderSectionPlaceholder({
  capability,
  providerName,
  access,
}: ProviderSectionPlaceholderProps) {
  const { t } = useTranslation();
  const navItem = NAV_ITEMS.find((item) => item.capability === capability);
  const title = navItem ? t(navItem.label) : capability;
  const provider = providerName ?? t('providers.unknownProvider');
  const isPlanned = access === 'inDevelopment';

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={title}
        subtitle={isPlanned ? t('providers.sectionPlannedSubtitle') : undefined}
        actions={
          isPlanned ? (
            <Badge tone="warning" withDot>
              {t('providers.inDevelopment')}
            </Badge>
          ) : (
            <Badge tone="neutral">{t('providers.unsupported')}</Badge>
          )
        }
      />

      <EmptyState
        icon={navItem?.icon ?? 'info'}
        title={
          isPlanned
            ? t('providers.sectionPlannedTitle', { provider })
            : t('providers.sectionUnsupportedTitle', { provider })
        }
        text={
          isPlanned
            ? t('providers.sectionPlannedText', { provider })
            : t('providers.sectionUnsupportedText', { provider })
        }
      />
    </Stack>
  );
}
