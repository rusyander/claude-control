import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Reorder } from 'motion/react';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion';
import { DURATION, EASE, withReducedMotion } from '@shared/lib/motion';
import { HOME_TAB_ID, type ProjectTab } from '@shared/lib/workspace';
import { statusTone, type RunStatus } from '@shared/lib/agent-runs';
import type { WorkspaceTabsProps } from './WorkspaceTabs.types';
import styles from './WorkspaceTabs.module.scss';

/** Alt+←/→ на табе — шаг влево/вправо, клавиатурная замена перетаскиванию. */
const MOVE_KEYS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };

/**
 * Лента табов рабочего пространства в шапке чата. Постоянный домашний таб
 * «Чаты» — для всего, что вне проектов; дальше идут открытые проекты. Таб
 * проекта можно закрыть — на его чаты это не влияет, закрывается только вкладка.
 *
 * Проекты переставляются перетаскиванием, порядок переживает перезагрузку.
 * Домашний таб в перестановке не участвует и всегда стоит первым: это не
 * проект, а точка возврата, и искать её на новом месте никто не должен.
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
  onReorder,
  onMove,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const isReduced = useReducedMotion();
  // Перетаскивание кончается кликом по той же кнопке. Без этого флага
  // перестановка фонового таба заодно переключала бы на него весь разговор.
  const dragged = useRef(false);
  const barRef = useRef<HTMLDivElement>(null);

  /**
   * Закрытие с клавиатуры уносит фокус в никуда: элемент, на котором он стоял,
   * исчез. Возвращаем его на вкладку, ставшую активной, — иначе после Delete
   * клавиатура оказывается в начале страницы.
   */
  const closeByKeyboard = (id: string): void => {
    onClose(id);
    window.setTimeout(() => {
      barRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    }, 0);
  };

  return (
    <Reorder.Group
      ref={barRef}
      as="div"
      axis="x"
      values={projectTabs}
      onReorder={(next: ProjectTab[]) => onReorder(next.map((tab) => tab.id))}
      className={styles.bar}
      role="tablist"
      aria-label={t('workspace.tabsLabel')}
    >
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
          // Перетаскивание живёт на контейнере: тянуть можно за весь таб.
          //
          // `presentation` на обёртке обязателен: без неё лента (`tablist`)
          // владеет не вкладками, а безымянными коробками — axe валит это как
          // critical, а проговаривается лента как пустая.
          <Reorder.Item
            as="div"
            key={tab.id}
            value={tab}
            role="presentation"
            dragMomentum={false}
            transition={withReducedMotion({ duration: DURATION.fast, ease: EASE }, isReduced)}
            onDragStart={() => {
              dragged.current = true;
            }}
            onDragEnd={() => {
              // Клик приходит следующим тиком — до него флаг снимать нельзя.
              window.setTimeout(() => {
                dragged.current = false;
              }, 0);
            }}
            className={`${styles.tab} ${styles.project} ${isActive ? styles.active : ''}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Delete"
              className={styles.tabLabel}
              onClick={() => {
                if (dragged.current) return;
                onActivate(tab.id);
              }}
              onKeyDown={(event) => {
                // Delete закрывает вкладку. Крестик из порядка Tab убран — он
                // вне дерева доступности, — и это единственный клавиатурный
                // путь к закрытию, ровно как предписывает ARIA.
                if (event.key === 'Delete') {
                  event.preventDefault();
                  closeByKeyboard(tab.id);
                  return;
                }
                const delta = MOVE_KEYS[event.key];
                if (!event.altKey || !delta) return;
                event.preventDefault();
                onMove(tab.id, delta);
              }}
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
            {/* Крестик — мышиный ярлык, а не отдельный орган управления: внутри
                ленты (`tablist`) чужая кнопка недопустима, лента перестаёт
                владеть одними вкладками. Из дерева доступности и из порядка Tab
                он убран, клавиатурное закрытие живёт на самой вкладке (Delete). */}
            <button
              type="button"
              className={styles.close}
              onClick={() => onClose(tab.id)}
              tabIndex={-1}
              aria-hidden="true"
              title={t('workspace.closeTab', { name: tab.name })}
            >
              <Icon name="close" size={14} />
            </button>
          </Reorder.Item>
        );
      })}
    </Reorder.Group>
  );
}
