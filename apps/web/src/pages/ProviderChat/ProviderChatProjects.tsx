import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SearchField } from '@shared/ui/search-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { EmptyState } from '@shared/ui/empty-state';
import { formatDate } from '@shared/lib/format';
import { projectRows } from './lib/projectRows';
import type { ProviderChatProjectsProps } from './ProviderChatProjects.types';
import styles from './ProviderChatPage.module.scss';

/**
 * Проекты всех провайдеров в чате чужого CLI. У каждого — бейджи тех, кто в нём
 * работал (Claude по его транскриптам, остальные по разговорам панели), и кнопка
 * нового разговора АКТИВНОГО провайдера в этом каталоге.
 *
 * Каталог, где разговор не начать (удалён, стал файлом), не прячется: кнопка
 * гаснет, а причина написана под ней — пропавший без объяснений проект человек
 * читает как поломку панели.
 */
export function ProviderChatProjects({
  projects,
  isLoading,
  providerId,
  providerName,
  onStart,
  isStarting,
}: ProviderChatProjectsProps) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const rows = useMemo(
    () => projectRows(projects, providerId, query),
    [projects, providerId, query],
  );

  if (isLoading) return <SkeletonList rows={4} withActions={false} />;

  if (projects.length === 0) {
    return (
      <EmptyState
        icon="folder"
        title={t('providerChat.projects.emptyTitle')}
        text={t('providerChat.projects.emptyText')}
      />
    );
  }

  return (
    <Stack gap="var(--spacing-2xs)" data-provider-projects>
      <SearchField
        label={t('providerChat.projects.search')}
        value={query}
        onChange={setQuery}
        placeholder={t('providerChat.projects.searchPlaceholder')}
      />
      <Typography variant="caption" color="subtle">
        {t('providerChat.projects.count', { count: rows.length })}
      </Typography>

      {rows.length === 0 && (
        <Typography variant="caption" color="subtle">
          {t('providerChat.projects.notFound')}
        </Typography>
      )}

      {rows.map((row) => (
        <div key={row.path} className={styles.projectItem} data-project-path={row.path}>
          <Stack direction="row" align="center" gap="var(--spacing-2xs)">
            <Icon name="folder" size={16} />
            <Typography variant="body-sm" weight="medium" as="span" truncate>
              {row.name}
            </Typography>
          </Stack>
          <Typography
            variant="mono"
            color="subtle"
            as="span"
            truncate
            className={styles.projectPath}
            title={row.path}
          >
            {row.path}
          </Typography>

          <Stack
            direction="row"
            align="center"
            gap="var(--spacing-3xs)"
            wrap
            role="list"
            aria-label={t('providerChat.projects.providersLabel')}
          >
            {row.badges.map((badge) => (
              <span
                key={badge.id}
                role="listitem"
                title={t('providerChat.projects.badgeTitle', {
                  provider: badge.name,
                  count: badge.chatCount,
                })}
                data-provider-badge={badge.id}
              >
                <Badge tone={badge.isActive ? 'accent' : 'neutral'}>{badge.name}</Badge>
              </span>
            ))}
            <Typography variant="caption" color="subtle" as="span">
              {formatDate(row.lastActivity, i18n.language)}
            </Typography>
          </Stack>

          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Icon name="plus" size={16} />}
            onClick={() => onStart(row.path)}
            disabled={Boolean(row.problem) || isStarting}
            aria-label={t('providerChat.projects.startHereLabel', {
              provider: providerName,
              name: row.name,
            })}
            fullWidth
          >
            {t('providerChat.projects.startHere')}
          </Button>
          {row.problem && (
            <Typography variant="caption" color="subtle" data-project-problem={row.problem}>
              {t(`providerChat.projects.problem.${row.problem}`)}
            </Typography>
          )}
        </div>
      ))}
    </Stack>
  );
}
