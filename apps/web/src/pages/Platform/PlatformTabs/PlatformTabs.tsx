import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import styles from './PlatformTabs.module.scss';
import type { PlatformTabsProps } from './PlatformTabs.types';
import { PLATFORM_TABS } from '../model/tabs.constants';
import type { PlatformTabId } from '../model/tabs.types';
import { platformTabDomId } from '../model/platformTabDomId';
import { platformPanelDomId } from '../model/platformPanelDomId';

/**
 * Полоса вкладок раздела «Контур» — настоящий `tablist`, как у настроек: Tab
 * заводит в полосу одной остановкой, стрелки/Home/End ходят по вкладкам, у
 * активной `tabindex=0`, у остальных `-1`. С края стрелка переходит на другой
 * край: вкладок шесть, упираться не во что.
 */
export function PlatformTabs({ active, onSelect }: PlatformTabsProps) {
  const { t } = useTranslation();
  const refs = useRef(new Map<PlatformTabId, HTMLButtonElement>());

  const jump = (id: PlatformTabId): void => {
    onSelect(id);
    refs.current.get(id)?.focus();
  };

  const move = (delta: number): void => {
    const index = PLATFORM_TABS.findIndex((tab) => tab.id === active);
    const next = PLATFORM_TABS[(index + delta + PLATFORM_TABS.length) % PLATFORM_TABS.length];
    if (next) jump(next.id);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const first = PLATFORM_TABS[0]?.id;
    const last = PLATFORM_TABS[PLATFORM_TABS.length - 1]?.id;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(-1);
    else if (event.key === 'Home' && first) jump(first);
    else if (event.key === 'End' && last) jump(last);
    else return;

    event.preventDefault();
  };

  return (
    <div
      role="tablist"
      aria-label={t('platform.tabsLabel')}
      className={styles.tabs}
      onKeyDown={handleKeyDown}
    >
      {PLATFORM_TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) refs.current.set(tab.id, node);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={platformTabDomId(tab.id)}
            aria-selected={isActive}
            // Панель в разметке только у открытой вкладки: ссылка с остальных
            // вела бы на несуществующий id (ревью 28.09, F-215).
            aria-controls={isActive ? platformPanelDomId(tab.id) : undefined}
            tabIndex={isActive ? 0 : -1}
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            <Icon name={tab.icon} size={18} />
            {t(`platform.tab.${tab.id}`)}
          </button>
        );
      })}
    </div>
  );
}
