import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from '@shared/hooks/use-reduced-motion/useReducedMotion';
import { Mascot } from '@shared/ui/mascot';
import { useMascotSpeechSlot } from '@shared/lib/mascot';
import { useMascotCompanion } from '../../lib/useMascotCompanion';
import { useCursorLook } from '../../lib/useCursorLook';
import { useBubblePlace } from '../../lib/useBubblePlace';
import { MascotPanel } from '../MascotPanel/MascotPanel';
import { SpeechBubble } from '../SpeechBubble/SpeechBubble';
import type { MascotCompanionProps } from './MascotCompanion.types';
import styles from './MascotCompanion.module.scss';

/** Столько щелчков подряд — и у Деки кружится голова. */
const POKES_TO_DIZZY = 5;

/** «Подряд» — в пределах этого окна, мс. */
const POKE_WINDOW_MS = 2_000;

/**
 * Дека внизу боковой панели — на каждой странице. Настроение берёт из прогонов
 * агентов и разговоров, ждущих ответа; о событиях говорит облачком рядом с
 * панелью; по щелчку открывает сводку: кто работает, кто ждёт, у кого ошибка,
 * и совет по месту. Окно сводки немодальное: страница за ним остаётся живой.
 */
export function MascotCompanion({ isCollapsed = false }: MascotCompanionProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);
  const companion = useMascotCompanion(isOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pokes = useRef<number[]>([]);
  const isReduced = useReducedMotion();
  const enabled = companion.prefs.enabled;
  useCursorLook(triggerRef, enabled && companion.mood === 'idle' && !isReduced);
  // Страница дала место для реплики (чат — над полем ввода) — реплика там, в
  // потоке, и ничего не накрывает; нет места — облачко у боковой панели.
  const speechSlot = useMascotSpeechSlot();
  const place = useBubblePlace(
    triggerRef,
    enabled && (isOpen || (companion.speech !== null && !speechSlot)),
  );

  // Выключили маскота в настройках при открытой сводке — закрываем и её.
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  // Открылась сводка — фокус на первое действие; щелчок мимо закрывает её.
  useEffect(() => {
    if (!isOpen) return undefined;
    panelRef.current?.querySelector<HTMLElement>('button, [href], input')?.focus();
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [isOpen]);

  if (!enabled) return null;

  const status = t(`mascot.status.${companion.status.key}`, { count: companion.status.count });

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onClick = (): void => {
    const now = Date.now();
    pokes.current = [...pokes.current.filter((at) => now - at < POKE_WINDOW_MS), now];
    if (pokes.current.length >= POKES_TO_DIZZY) {
      pokes.current = [];
      setOpen(false);
      companion.poke();
      return;
    }
    if (isOpen) {
      close();
      return;
    }
    companion.dismissSpeech();
    setOpen(true);
  };

  return (
    <div className={styles.slot} data-mascot-companion data-mascot-mood={companion.mood}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={onClick}
        aria-label={t('mascot.buttonAria', { status })}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        title={`${t('mascot.name')}: ${status}`}
        data-mascot-trigger
      >
        <Mascot mood={companion.mood} size={40} />
        <span
          className={styles.caption}
          data-collapsed={isCollapsed || undefined}
          aria-hidden="true"
        >
          <span className={styles.name}>{t('mascot.name')}</span>
          <span className={styles.status} data-tone={companion.status.key}>
            {status}
          </span>
        </span>
      </button>

      {isOpen &&
        createPortal(
          <MascotPanel
            ref={panelRef}
            style={place}
            companion={companion}
            onClose={close}
            onNavigate={() => setOpen(false)}
          />,
          document.body,
        )}
      {!isOpen &&
        companion.speech &&
        createPortal(
          <SpeechBubble
            speech={companion.speech}
            {...(speechSlot ? { inline: true } : { style: place })}
            onOpen={(target) => {
              companion.dismissSpeech();
              companion.openChat(target);
            }}
            onDismiss={companion.dismissSpeech}
          />,
          speechSlot ?? document.body,
        )}
    </div>
  );
}
