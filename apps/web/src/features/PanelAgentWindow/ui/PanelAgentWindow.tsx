import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'motion/react';
import { DURATION, EASE, withReducedMotion } from '@shared/lib/motion';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion/useReducedMotion';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { focusWindow } from '../model/focusAnchor';
import { ConversationView } from './ConversationView';
import { HistoryView } from './HistoryView';
import { JournalView } from './JournalView';
import type { PanelAgentView, PanelAgentWindowProps } from './PanelAgentWindow.types';
import styles from './PanelAgent.module.scss';

const VIEWS: PanelAgentView[] = ['conversation', 'history', 'journal'];

const SLIDE = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0 },
};

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

  // Ждущая карточка важнее истории: окно, открытое кадром, показывает разговор.
  const shown = conversation.pending.length > 0 ? 'conversation' : view;

  // Просьба кнопки агента: фокус в окно — к ждущей карточке или в поле ввода.
  // Счётчик, а не флаг: повторное нажатие при уже открытом окне тоже просьба.
  useEffect(() => {
    if (!isOpen || focusRequest === 0 || !panelRef.current) return;
    focusWindow(panelRef.current);
  }, [focusRequest, isOpen, panelRef]);

  const openConversation = (id: string): void => {
    void session.openConversation(id).then(() => setView('conversation'));
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
          variants={SLIDE}
          initial="hidden"
          animate="visible"
          exit="hidden"
          transition={withReducedMotion({ duration: DURATION.normal, ease: EASE }, isReduced)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            onClose();
          }}
        >
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
                  aria-pressed={shown === item}
                  onClick={() => setView(item)}
                >
                  {t(`panelAgent.views.${item}`)}
                </button>
              ))}
              {shown === 'conversation' && session.state.feed.length > 0 && (
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

            {shown === 'conversation' && <ConversationView session={session} {...conversation} />}
            {shown === 'history' && <HistoryView onOpen={openConversation} />}
            {shown === 'journal' && <JournalView />}
          </div>
        </motion.section>
      )}
    </AnimatePresence>,
    document.body,
  );
}
