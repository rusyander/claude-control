import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { DURATION, EASE, withReducedMotion } from '@shared/lib/motion';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion/useReducedMotion';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { isEscapeYieldedToSideDock } from '@shared/lib/side-dock';
import { ResizeHandle } from '@shared/ui/resize-handle';
import { useDockWidth } from '../../model/useDockWidth';
import { ConversationView } from '../ConversationView/ConversationView';
import { HistoryView } from '../HistoryView/HistoryView';
import { JournalView } from '../JournalView/JournalView';
import type { PanelAgentView, PanelAgentWindowProps } from './PanelAgentWindow.types';
import styles from './PanelAgentWindow.module.scss';
import { focusWindow } from '../../model/focusAnchor';
import { VIEWS, SLIDE } from './PanelAgentWindow.constants';

/**
 * Окно агента, пристёгнутое к правому краю, без затемнения и без ловушки
 * фокуса. Модальным оно быть не может: агент открывает страницу, чтобы человек
 * увидел результат, а разговор при этом идёт дальше и приносит новые карточки —
 * модальное окно пришлось бы закрывать ради страницы и терять из виду. Поэтому
 * `role="dialog"` с `aria-modal="false"`: страница за окном живая, Tab выходит
 * из окна на неё, Escape внутри окна закрывает его.
 */
export function PanelAgentWindow({
  isOpen,
  onClose,
  focusRequest,
  panelRef,
  session,
  ...conversation
}: PanelAgentWindowProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<PanelAgentView>('conversation');
  const isReduced = useReducedMotion();
  const titleId = useId();
  const descriptionId = useId();
  const dock = useDockWidth();

  // Новая карточка СВОЕГО разговора возвращает окно к разговору — один раз, при
  // появлении; дальше выбирает человек. Карточка другой вкладки или телефона
  // видна в разговоре и на значке, но вид не держит: иначе «История» и «Журнал»
  // не нажимались бы, пока где-то ждёт чужое решение.
  const ownPendingIds = conversation.pending
    .filter((card) => session.isOwn(card.conversationId))
    .map((card) => card.id);
  const ownPendingKey = ownPendingIds.join(',');
  const seenPendingRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const ids = ownPendingKey ? ownPendingKey.split(',') : [];
    if (ids.some((id) => !seenPendingRef.current.has(id))) setView('conversation');
    seenPendingRef.current = new Set(ids);
  }, [ownPendingKey]);

  // Просьба кнопки агента: фокус в окно — к ждущей карточке или в поле ввода.
  // Счётчик, а не флаг: повторное нажатие при уже открытом окне тоже просьба.
  useEffect(() => {
    if (!isOpen || focusRequest === 0 || !panelRef.current) return;
    focusWindow(panelRef.current);
  }, [focusRequest, isOpen, panelRef]);

  const openConversation = (id: string): void => {
    void session
      .openConversation(id)
      .catch(() => session.note(t('panelAgent.history.openFailed'), 'error'))
      .finally(() => setView('conversation'));
  };

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.section
          ref={panelRef}
          key="panel-agent-window"
          className={styles.dock}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          tabIndex={-1}
          data-panel-agent-window
          data-side-dock
          variants={SLIDE}
          initial="hidden"
          animate="visible"
          exit="hidden"
          transition={withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // Модальное окно страницы рядом уступило этот Escape окну (side-dock).
            if (event.defaultPrevented && !isEscapeYieldedToSideDock(event.nativeEvent)) return;
            event.preventDefault();
            onClose();
          }}
        >
          {/* Ширину тянут за левый край — мышью или стрелками с клавиатуры. На
              узком экране окно во весь экран, и тянуть там нечего. */}
          {dock.isWide && (
            <div className={styles.resizeEdge} data-panel-agent-resize>
              <ResizeHandle
                width={dock.width}
                min={dock.min}
                max={dock.max}
                label={t('panelAgent.resize')}
                onResize={dock.resize}
              />
            </div>
          )}
          <header className={styles.dockHeader}>
            <div className={styles.dockTitle}>
              <Typography variant="heading-sm" as="h2" id={titleId}>
                {t('panelAgent.title')}
              </Typography>
              <Typography variant="body-sm" color="muted" id={descriptionId}>
                {t('panelAgent.subtitle')}
              </Typography>
            </div>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<Icon name="close" size={24} />}
              aria-label={t('common.close')}
              onClick={onClose}
            />
          </header>

          <div className={styles.window}>
            <div className={styles.views}>
              {VIEWS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={styles.viewButton}
                  aria-pressed={view === item}
                  onClick={() => setView(item)}
                >
                  {t(`panelAgent.views.${item}`)}
                </button>
              ))}
              {view === 'conversation' && session.state.feed.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="plus" size={16} />}
                  onClick={session.reset}
                  disabled={session.state.running}
                >
                  {t('panelAgent.newConversation')}
                </Button>
              )}
            </div>

            {view === 'conversation' && (
              <ConversationView
                session={session}
                {...conversation}
                onOpenConversation={openConversation}
              />
            )}
            {view === 'history' && (
              <HistoryView
                onOpen={openConversation}
                isBusy={session.state.running}
                {...(session.state.conversationId
                  ? { currentId: session.state.conversationId }
                  : {})}
                onDeleted={(id) => {
                  if (id === session.state.conversationId) session.reset();
                }}
              />
            )}
            {view === 'journal' && <JournalView />}
          </div>
        </motion.section>
      )}
    </AnimatePresence>,
    document.body,
  );
}
