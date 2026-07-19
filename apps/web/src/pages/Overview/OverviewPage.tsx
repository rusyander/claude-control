import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonTiles } from '@shared/ui/skeleton';
import { PageHeader } from '@shared/ui/page-header';
import { useLocation, useOverview } from '@entities/AppConfig';
import { LocationCard } from './LocationCard';
import { StatTile } from './StatTile';
import styles from './OverviewPage.module.scss';

/** Главный экран: где лежит конфигурация и что в ней есть. */
export function OverviewPage() {
  const { t } = useTranslation();
  const { data: location } = useLocation();
  const { data: overview, isLoading } = useOverview();

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('overview.title')}
        subtitle={t('overview.subtitle')}
        helpTopic="overview"
      />

      {location && <LocationCard location={location} />}

      {isLoading && <SkeletonTiles count={7} />}

      {overview && (
        <div className={styles.grid}>
          <StatTile
            icon="rules"
            label={t('nav.rules')}
            value={overview.rules.total}
            hint={`${overview.rules.enabled} ${t('common.enabled').toLowerCase()}`}
            to="/rules"
          />
          <StatTile
            icon="skills"
            label={t('nav.skills')}
            value={overview.skills.total}
            hint={`${overview.skills.enabled} ${t('common.enabled').toLowerCase()}`}
            to="/skills"
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
          />
          <StatTile
            icon="mcp"
            label={t('nav.mcp')}
            value={overview.mcp.total}
            hint={`${overview.mcp.enabled} ${t('common.enabled').toLowerCase()}`}
            to="/mcp"
          />
          <StatTile
            icon="permissions"
            label={t('nav.permissions')}
            value={
              overview.permissions.allow + overview.permissions.ask + overview.permissions.deny
            }
            // Раньше здесь стояло «119 / 7» — два числа без пояснения, гадать
            // приходилось каждый раз. Подписываем.
            hint={`${overview.permissions.allow} ${t(
              'permissions.allow',
            ).toLowerCase()} · ${overview.permissions.deny} ${t('permissions.deny').toLowerCase()}`}
            to="/permissions"
          />
          <StatTile
            icon="groups"
            label={t('nav.groups')}
            value={overview.groups.total}
            hint={
              overview.groups.total > 0
                ? `${overview.groups.total} ${t('overview.groupsHint')}`
                : t('overview.groupsEmpty')
            }
            to="/groups"
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
