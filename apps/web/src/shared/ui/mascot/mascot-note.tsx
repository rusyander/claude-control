import { useMascotPrefs } from '@shared/lib/mascot';
import { Mascot } from './mascot';
import type { MascotNoteProps } from './mascot.types';
import styles from './mascot-scenes.module.scss';

/**
 * Дека с одной фразой — на экранах, где что-то пошло не так («не найдено»,
 * сбой раздела). Смысл страницы несёт её собственный текст, Дека лишь смягчает
 * момент, поэтому выключенный маскот не оставляет здесь ничего.
 */
export function MascotNote({ mood, text }: MascotNoteProps) {
  const { enabled } = useMascotPrefs();
  if (!enabled) return null;

  return (
    <div className={styles.note} data-mascot-note={mood}>
      <Mascot mood={mood} size={64} />
      <p className={styles.noteText}>{text}</p>
    </div>
  );
}
