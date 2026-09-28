import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { GROUPS_TABS, groupsPanelDomId, groupsTabDomId, type GroupsTabId } from './model/tabs';
import type { GroupsTabCount, GroupsTabsProps } from './GroupsTabs.types';
import styles from './GroupsTabs.module.scss';

/**
 * Вкладки страницы групп с числом в каждой: сколько групп, находок, источников.
 * У «Обнаружения» ошибки видны прямо на вкладке — человек не должен заходить в
 * журнал, чтобы узнать, что там что-то сломалось. Настоящий tablist: одна
 * остановка Tab, стрелки/Home/End ходят по вкладкам.
 */
export function GroupsTabs({ active, counts, onSelect }: GroupsTabsProps) {
  const { t } = useTranslation();
  const refs = useRef(new Map<GroupsTabId, HTMLButtonElement>());

  const jump = (tab: GroupsTabId): void => {
    onSelect(tab);
    refs.current.get(tab)?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // От вкладки под фокусом, а не от открытой: фокус мог прийти щелчком мимо неё.
    const focused = GROUPS_TABS.find((tab) => refs.current.get(tab) === document.activeElement);
    const index = GROUPS_TABS.indexOf(focused ?? active);
    let next: GroupsTabId | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      next = GROUPS_TABS[(index + delta + GROUPS_TABS.length) % GROUPS_TABS.length];
    } else if (event.key === 'Home') next = GROUPS_TABS[0];
    else if (event.key === 'End') next = GROUPS_TABS[GROUPS_TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    jump(next);
  };

  return (
    <div
      role="tablist"
      aria-label={t('groupsPage.tabsLabel')}
      className={styles.tabs}
      onKeyDown={handleKeyDown}
    >
      {GROUPS_TABS.map((tab) => {
        const isActive = tab === active;
        const { count, errors = 0 } = counts[tab];
        const label = t(`groupsPage.tab.${tab}`);
        const errorText = errors > 0 ? t('groupsPage.tabErrors', { count: errors }) : '';
        const countText = spokenCount(count, t);
        return (
          <button
            key={tab}
            ref={(node) => {
              if (node) refs.current.set(tab, node);
              else refs.current.delete(tab);
            }}
            type="button"
            role="tab"
            id={groupsTabDomId(tab)}
            aria-selected={isActive}
            // Панель в разметке только у открытой вкладки: ссылка с остальных
            // вела бы на несуществующий id.
            aria-controls={isActive ? groupsPanelDomId(tab) : undefined}
            aria-label={t('groupsPage.tabAria', { label, count: errorText || countText })}
            tabIndex={isActive ? 0 : -1}
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            onClick={() => onSelect(tab)}
          >
            <span>{label}</span>
            <span
              className={`${styles.count} ${errors > 0 || count === 'failed' ? styles.countDanger : ''}`}
              title={errorText || undefined}
            >
              {errors > 0 ? (
                <>
                  {/* На узком экране — только число: слово выталкивало вкладку за край. */}
                  <span className={styles.wide}>{errorText}</span>
                  <span className={styles.narrow}>!{errors}</span>
                </>
              ) : (
                shownCount(count)
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Число на вкладке: «…» — читается, «!» — не прочиталось. */
function shownCount(count: GroupsTabCount['count']): string {
  if (count === 'loading') return '…';
  if (count === 'failed') return '!';
  return String(count);
}

/** То же для скринридера — словами. */
function spokenCount(count: GroupsTabCount['count'], t: TFunction): string {
  if (count === 'loading') return t('groupsPage.tabCountLoading');
  if (count === 'failed') return t('groupsPage.tabCountFailed');
  return String(count);
}
