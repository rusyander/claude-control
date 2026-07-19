import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Button } from '@shared/ui/button';
import { useOverview } from '@entities/AppConfig';
import { NAV_SECTIONS } from './Sidebar.constants';
import { AppMark } from './AppMark';
import styles from './MainLayout.module.scss';

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

/**
 * Боковая навигация со счётчиками: видно объём каждого раздела до перехода.
 * В свёрнутом виде остаются только значки — подписи и счётчики прячутся,
 * а сама панель ужимается до ширины иконки.
 */
export function Sidebar({ isCollapsed, onToggle }: SidebarProps) {
  const { t } = useTranslation();
  const { data: overview } = useOverview();

  const counts: Record<string, number | undefined> = {
    rules: overview?.rules.total,
    hooks: overview?.hooks.total,
    skills: overview?.skills.total,
    scripts: overview?.scripts.total,
    mcp: overview?.mcp.total,
    permissions: overview
      ? overview.permissions.allow + overview.permissions.ask + overview.permissions.deny
      : undefined,
    groups: overview?.groups.total,
  };

  return (
    <Stack
      as="nav"
      className={`${styles.sidebar} ${isCollapsed ? styles.sidebarCollapsed : ''}`}
      gap="var(--spacing-3xs)"
    >
      <div className={styles.brand}>
        <AppMark size={isCollapsed ? 28 : 32} />

        {!isCollapsed && (
          <Stack gap="var(--spacing-3xs)" className={styles.brandText}>
            <Typography variant="heading-sm">{t('common.appName')}</Typography>
            <Typography variant="caption" color="subtle">
              {t('common.appTagline')}
            </Typography>
          </Stack>
        )}

        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Icon name={isCollapsed ? 'chevronRight' : 'chevronLeft'} size={20} />}
          aria-label={t(isCollapsed ? 'common.expandSidebar' : 'common.collapseSidebar')}
          onClick={onToggle}
          className={styles.collapseButton}
        />
      </div>

      {NAV_SECTIONS.map((section) => (
        <Stack key={section.label} gap="var(--spacing-3xs)">
          {!isCollapsed && (
            <Typography variant="caption" color="subtle" className={styles.sectionLabel}>
              {t(section.label)}
            </Typography>
          )}

          {section.items.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={styles.navLink}
              // В свёрнутом виде подписи нет — подсказка браузера её заменяет.
              title={isCollapsed ? t(item.label) : undefined}
            >
              <Icon name={item.icon} size={24} />

              {!isCollapsed && (
                <>
                  {t(item.label)}
                  {counts[item.key] !== undefined && (
                    <span className={styles.navCount}>{counts[item.key]}</span>
                  )}
                </>
              )}
            </Link>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
