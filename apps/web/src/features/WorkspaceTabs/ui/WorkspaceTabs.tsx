import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { HOME_TAB_ID } from '@shared/lib/workspace';
import { statusTone, type RunStatus } from '@shared/lib/agent-runs';
import type { WorkspaceTabsProps } from './WorkspaceTabs.types';
import styles from './WorkspaceTabs.module.scss';

/**
 * Лента табов рабочего пространства в шапке чата. Постоянный домашний таб
 * «Чаты» — для всего, что вне проектов; дальше идут открытые проекты. Таб
 * проекта можно закрыть — на его чаты это не влияет, закрывается только вкладка.
 *
 * При одном лишь домашнем табе ленту не показываем (см. вызывающий код): пустая
 * полоса из одной вкладки только занимает место.
 */
export function WorkspaceTabs({
  projectTabs,
  activeTabId,
  statuses,
  onActivate,
  onClose,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.bar} role="tablist" aria-label={t('workspace.tabsLabel')}>
      <button
        type="button"
        role="tab"
        aria-selected={activeTabId === HOME_TAB_ID}
        className={`${styles.tab} ${activeTabId === HOME_TAB_ID ? styles.active : ''}`}
        onClick={() => onActivate(HOME_TAB_ID)}
      >
        <Icon name="chat" size={16} />
        <Typography variant="body-sm" as="span">
          {t('workspace.homeTab')}
        </Typography>
      </button>

      {projectTabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const status: RunStatus = statuses?.get(tab.id) ?? 'idle';
        return (
          // Контейнер — не виджет: роль tab на самой кнопке, а кнопка закрытия —
          // её сосед, иначе получились бы вложенные интерактивные элементы.
          <div
            key={tab.id}
            className={`${styles.tab} ${styles.project} ${isActive ? styles.active : ''}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              className={styles.tabLabel}
              onClick={() => onActivate(tab.id)}
              title={tab.path}
            >
              <StatusDot
                tone={statusTone(status)}
                // Пульсируем не только у «работает», но и у «ждёт ответа»/«ошибка»:
                // это те состояния, где от тебя что-то нужно — пусть бросаются в глаза.
                // Молчащий не пульсирует: событий нет — и точка стоит ровно.
                pulse={status !== 'idle' && status !== 'quiet'}
                label={status !== 'idle' ? t(`workspace.status.${status}`) : undefined}
              />
              <Icon name="folder" size={16} />
              <Typography variant="body-sm" as="span" truncate className={styles.name}>
                {tab.name}
              </Typography>
            </button>
            <button
              type="button"
              className={styles.close}
              onClick={() => onClose(tab.id)}
              aria-label={t('workspace.closeTab', { name: tab.name })}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
