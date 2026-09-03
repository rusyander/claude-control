import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import {
  SETTINGS_TABS,
  settingsPanelDomId,
  settingsTabDomId,
  type SettingsTabId,
} from './model/tabs';
import type { SettingsTabsProps } from './SettingsTabs.types';
import styles from './SettingsPage.module.scss';

/**
 * Полоса разделов настроек.
 *
 * Это настоящий `tablist`, а не ряд кнопок: в табы ходят и с клавиатуры, а
 * правило одной точки входа (Tab заводит в полосу, стрелки ходят по вкладкам)
 * работает только с ролями и «плавающим» tabindex — активная вкладка
 * фокусируемая, остальные нет. Стрелка с края переходит на другой край: список
 * короткий, и упираться в него нечем.
 */
export function SettingsTabs({ active, onSelect }: SettingsTabsProps) {
  const { t } = useTranslation();
  const refs = useRef(new Map<SettingsTabId, HTMLButtonElement>());

  const move = (delta: number): void => {
    const index = SETTINGS_TABS.findIndex((tab) => tab.id === active);
    const next = SETTINGS_TABS[(index + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    if (!next) return;
    onSelect(next.id);
    refs.current.get(next.id)?.focus();
  };

  const jump = (id: SettingsTabId): void => {
    onSelect(id);
    refs.current.get(id)?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const first = SETTINGS_TABS[0]?.id;
    const last = SETTINGS_TABS[SETTINGS_TABS.length - 1]?.id;

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
      aria-label={t('settings.tabsLabel')}
      className={styles.tabs}
      onKeyDown={handleKeyDown}
    >
      {SETTINGS_TABS.map((tab) => {
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
            id={settingsTabDomId(tab.id)}
            aria-selected={isActive}
            aria-controls={settingsPanelDomId(tab.id)}
            tabIndex={isActive ? 0 : -1}
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            <Icon name={tab.icon} size={18} />
            {t(`settings.tab_${tab.id}`)}
          </button>
        );
      })}
    </div>
  );
}
