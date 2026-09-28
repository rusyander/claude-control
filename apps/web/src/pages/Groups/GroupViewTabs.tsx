import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupView, GroupViewTabsProps } from './GroupViewTabs.types';
import styles from './GroupViewTabs.module.scss';

const VIEWS: GroupView[] = ['path', 'members'];

const LABEL_KEYS: Record<GroupView, string> = {
  path: 'groupPath.tabPath',
  members: 'groupPath.tabMembers',
};

export function groupViewTabId(idBase: string, view: GroupView): string {
  return `${idBase}-tab-${view}`;
}

export function groupViewPanelId(idBase: string, view: GroupView): string {
  return `${idBase}-panel-${view}`;
}

/**
 * Вкладки окна группы: «Порядок работы» (по умолчанию — ради него группу и
 * открывают) и «Состав». Настоящий tablist: одна остановка Tab, стрелки/Home/End
 * ходят по вкладкам.
 */
export function GroupViewTabs({ idBase, active, onSelect }: GroupViewTabsProps) {
  const { t } = useTranslation();
  const refs = useRef(new Map<GroupView, HTMLButtonElement>());

  const jump = (view: GroupView): void => {
    onSelect(view);
    refs.current.get(view)?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = VIEWS.indexOf(active);
    let next: GroupView | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      next = VIEWS[(index + delta + VIEWS.length) % VIEWS.length];
    } else if (event.key === 'Home') next = VIEWS[0];
    else if (event.key === 'End') next = VIEWS[VIEWS.length - 1];
    if (!next) return;
    event.preventDefault();
    jump(next);
  };

  return (
    <div
      role="tablist"
      aria-label={t('groupPath.tabsLabel')}
      className={styles.tabs}
      onKeyDown={handleKeyDown}
    >
      {VIEWS.map((view) => {
        const isActive = view === active;
        return (
          <button
            key={view}
            ref={(node) => {
              if (node) refs.current.set(view, node);
              else refs.current.delete(view);
            }}
            type="button"
            role="tab"
            id={groupViewTabId(idBase, view)}
            aria-selected={isActive}
            // Панель в разметке только у открытой вкладки: ссылка с остальных
            // вела бы на несуществующий id.
            aria-controls={isActive ? groupViewPanelId(idBase, view) : undefined}
            tabIndex={isActive ? 0 : -1}
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            onClick={() => onSelect(view)}
          >
            {t(LABEL_KEYS[view])}
          </button>
        );
      })}
    </div>
  );
}
