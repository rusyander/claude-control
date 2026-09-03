import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonTiles } from '@shared/ui/skeleton';
import { PageHeader } from '@shared/ui/page-header';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { formatDate } from '@shared/lib/format';
import { useLocation, useOverview } from '@entities/AppConfig';
import { LocationCard } from './LocationCard';
import { StatTile } from './StatTile';
import { ChangesSummary } from './ChangesSummary';
import styles from './OverviewPage.module.scss';

/** Главный экран: где лежит конфигурация и что в ней есть. */
export function OverviewPage() {
  const { t, i18n } = useTranslation();
  const { data: location } = useLocation();
  const { data: overview, isLoading } = useOverview();

  // Копии: сколько и когда снимали последнюю — раньше это было видно только в
  // настройках, а на обзоре к месту.
  const { data: backups } = useQuery({
    queryKey: queryKeys.backups,
    queryFn: async () => (await apiClient.get<{ items: { createdAt: string }[] }>('/backups')).data,
  });

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('overview.title')}
        subtitle={t('overview.subtitle')}
        helpTopic="overview"
      />

      {location && <LocationCard location={location} />}

      <ChangesSummary />

      {/* Столько же, сколько плиток ниже: иначе сетка «прыгает» на восьмой. */}
      {isLoading && <SkeletonTiles count={8} />}

      {overview && (
        <div className={styles.grid}>
          <StatTile
            icon="rules"
            label={t('nav.rules')}
            value={overview.rules.total}
            hint={`${overview.rules.enabled} ${t('common.enabled').toLowerCase()}`}
            to="/rules"
            actions={[
              {
                label: t('overview.quickAdd'),
                to: '/rules',
                search: { create: true },
                icon: 'plus',
              },
              { label: t('overview.quickClaudeMd'), to: '/claude-md', icon: 'edit' },
            ]}
          />
          <StatTile
            icon="skills"
            label={t('nav.skills')}
            value={overview.skills.total}
            hint={`${overview.skills.enabled} ${t('common.enabled').toLowerCase()}`}
            to="/skills"
            actions={[
              {
                label: t('overview.quickAdd'),
                to: '/skills',
                search: { create: true },
                icon: 'plus',
              },
            ]}
          />
          <StatTile
            icon="hooks"
            label={t('nav.hooks')}
            value={overview.hooks.total}
            hint={
              overview.hooks.broken > 0
                ? `${overview.hooks.broken} ${t('overview.brokenHooks')}`
                : `${overview.hooks.enabled} ${t('common.enabled').toLowerCase()}`
            }
            tone={overview.hooks.broken > 0 ? 'danger' : undefined}
            to="/hooks"
            actions={[
              {
                label: t('overview.quickAdd'),
                to: '/hooks',
                search: { create: true },
                icon: 'plus',
              },
            ]}
          />
          <StatTile
            icon="scripts"
            label={t('nav.scripts')}
            value={overview.scripts.total}
            hint={
              overview.scripts.unused > 0
                ? `${overview.scripts.unused} ${t('overview.unusedScripts')}`
                : t('overview.allScriptsUsed')
            }
            to="/scripts"
            actions={[
              {
                label: t('overview.quickAdd'),
                to: '/scripts',
                search: { create: true },
                icon: 'plus',
              },
            ]}
          />
          <StatTile
            icon="mcp"
            label={t('nav.mcp')}
            value={overview.mcp.total}
            hint={
              overview.mcp.failed > 0
                ? `${overview.mcp.failed} ${t('overview.mcpFailed')}`
                : `${overview.mcp.enabled} ${t('common.enabled').toLowerCase()}`
            }
            tone={overview.mcp.failed > 0 ? 'danger' : undefined}
            to="/mcp"
            actions={[
              { label: t('overview.quickAdd'), to: '/mcp', search: { create: true }, icon: 'plus' },
            ]}
          />
          <StatTile
            icon="permissions"
            label={t('nav.permissions')}
            value={
              overview.permissions.allow + overview.permissions.ask + overview.permissions.deny
            }
            // Раньше здесь стояло «119 / 7» — два числа без пояснения, гадать
            // приходилось каждый раз. Подписываем; «спросить» показываем только
            // когда такие правила есть, иначе сумма сверху не сходилась бы с подписью.
            hint={[
              `${overview.permissions.allow} ${t('permissions.allow').toLowerCase()}`,
              ...(overview.permissions.ask > 0
                ? [`${overview.permissions.ask} ${t('overview.permissionsAsk')}`]
                : []),
              `${overview.permissions.deny} ${t('permissions.deny').toLowerCase()}`,
            ].join(' · ')}
            to="/permissions"
          />
          <StatTile
            icon="groups"
            label={t('nav.groups')}
            value={overview.groups.total}
            hint={
              overview.groups.total > 0
                ? t('overview.groupsHint', { count: overview.groups.total })
                : t('overview.groupsEmpty')
            }
            to="/groups"
          />
          <StatTile
            icon="file"
            label={t('overview.backups')}
            value={backups?.items.length ?? 0}
            hint={
              backups && backups.items.length > 0
                ? `${t('overview.backupsLast')}: ${formatDate(backups.items[0]!.createdAt, i18n.language)}`
                : t('overview.backupsNone')
            }
            to="/settings"
            // Копии живут во вкладке «Безопасность» — плитка ведёт прямо в неё,
            // а не на первый раздел настроек.
            search={{ tab: 'safety' }}
            actions={[{ label: t('overview.quickHistory'), to: '/history', icon: 'history' }]}
          />
        </div>
      )}

      {/*
        Отдельной карточки с разбивкой прав здесь больше нет: она повторяла
        числа из плитки выше, а подробности всё равно смотрят на самой
        странице прав.
      */}
    </Stack>
  );
}
