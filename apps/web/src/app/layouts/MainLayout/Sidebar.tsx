import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { motion } from 'motion/react';
import { SPRING, DURATION, EASE, withReducedMotion } from '@shared/lib/motion';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion/useReducedMotion';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { useOverview } from '@entities/AppConfig';
import { NAV_SECTIONS } from './Sidebar.constants';
import { AppMark } from './AppMark';
import styles from './MainLayout.module.scss';

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

/**
 * Ширины держим числами: анимировать значение из CSS-переменной нельзя,
 * а раскладка на них и так завязана (см. --layout-sidebar-width).
 */
const EXPANDED_WIDTH = 260;
const COLLAPSED_WIDTH = 60;

/**
 * Боковая навигация со счётчиками: видно объём каждого раздела до перехода.
 *
 * Как устроено сворачивание. Анимируется **только ширина самой панели**, а её
 * содержимое всегда лежит в блоке постоянной ширины и просто обрезается краем.
 * Так задумано: пока содержимое пережималось вместе с панелью, подписи
 * переносились на новую строку, значки ползли по горизонтали, а часть стилей
 * (отступы, выравнивание) переключалась классом мгновенно — и всё это читалось
 * как рывок. Теперь внутри не двигается ничего: подписи гаснут на месте.
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

  const isReduced = useReducedMotion();
  const width = withReducedMotion(SPRING, isReduced);
  const fade = withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced);

  /** Подпись, исчезающая вместе со сворачиванием. Место за собой сохраняет. */
  const label = (children: React.ReactNode, className?: string) => (
    <motion.span
      className={className}
      initial={false}
      animate={{ opacity: isCollapsed ? 0 : 1 }}
      transition={fade}
      // Погасшая подпись не должна перехватывать курсор на узкой панели.
      style={{ pointerEvents: isCollapsed ? 'none' : undefined }}
    >
      {children}
    </motion.span>
  );

  return (
    <motion.nav
      className={styles.sidebar}
      // initial={false} — при первой отрисовке панель стоит на месте,
      // а не разъезжается на глазах.
      initial={false}
      animate={{ width: isCollapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
      transition={width}
      aria-label={t('nav.sectionMain')}
    >
      <div className={styles.sidebarInner}>
        <div className={styles.brand}>
          <AppMark size={32} />
          {label(
            <Typography variant="heading-sm" as="span">
              {t('common.appName')}
            </Typography>,
          )}
        </div>

        {/*
          Сворачивание — такая же строка, как пункты меню: значок всегда на
          одном месте, поэтому при смене ширины кнопке некуда прыгать.
        */}
        <button
          type="button"
          className={styles.navLink}
          onClick={onToggle}
          data-sidebar-toggle
          // Подпись рядом гаснет при сворачивании, поэтому имя кнопки задаём
          // явно: иначе в свёрнутом виде она осталась бы без названия.
          aria-label={t(isCollapsed ? 'common.expandSidebar' : 'common.collapseSidebar')}
          aria-expanded={!isCollapsed}
        >
          <Icon name={isCollapsed ? 'chevronRight' : 'chevronLeft'} size={24} />
          {label(
            t(isCollapsed ? 'common.expandSidebar' : 'common.collapseSidebar'),
            styles.navLabel,
          )}
        </button>

        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className={styles.navSection}>
            {label(t(section.label), styles.sectionLabel)}

            {section.items.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                className={styles.navLink}
                // В свёрнутом виде подписи не видно — подсказка браузера её заменяет.
                title={isCollapsed ? t(item.label) : undefined}
              >
                <Icon name={item.icon} size={24} />

                {label(
                  <>
                    {t(item.label)}
                    {counts[item.key] !== undefined && (
                      <span className={styles.navCount}>{counts[item.key]}</span>
                    )}
                  </>,
                  styles.navLabel,
                )}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </motion.nav>
  );
}
