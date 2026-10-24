import { useEffect, useRef } from 'react';
import { registerMascotSpeechSlot } from '@shared/lib/mascot';
import styles from './mascot-scenes.module.scss';

/**
 * Место для реплики Деки в потоке страницы (чат — над полем ввода). Пустое
 * место не занимает ничего; реплику в него кладёт спутник Деки порталом.
 * Живая область — само место, а не реплика: область, появившаяся вместе с
 * текстом, диктором часто не читается, а постоянная — читается, вежливо, не
 * перебивая (`aria-live="polite"`).
 */
export function MascotSpeechSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    return registerMascotSpeechSlot(element);
  }, []);
  return (
    <div
      ref={ref}
      className={styles.speechSlot}
      role="status"
      aria-live="polite"
      data-mascot-speech-slot
    />
  );
}
