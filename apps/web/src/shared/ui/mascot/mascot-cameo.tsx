import { useTranslation } from 'react-i18next';
import { cameoLine, useMascotPrefs } from '@shared/lib/mascot';
import { Mascot } from './mascot';
import type { MascotCameoProps } from './mascot.types';
import styles from './mascot-scenes.module.scss';

/**
 * Дека у таймера живого прогона в чате. Короткий ход его не видит; на долгом
 * он выходит, работает рядом и раз в минуту коротко говорит, что можно уйти —
 * позовёт. Время берёт у таймера: второй секундный тик ради маскота не нужен.
 *
 * Для чтения с экрана скрыт: таймер рядом уже говорит, что ход идёт, а реплика
 * раз в минуту в живой области только мешала бы.
 */
export function MascotCameo({ elapsed }: MascotCameoProps) {
  const { t } = useTranslation();
  const prefs = useMascotPrefs();
  const line = cameoLine(elapsed, prefs.chatty);
  if (!prefs.enabled || !line.visible) return null;

  return (
    <span className={styles.cameo} aria-hidden="true" data-mascot-cameo>
      <Mascot mood="working" size={26} />
      {line.key && (
        <span className={styles.cameoLine} data-mascot-cameo-line={line.key}>
          {t(`mascot.cameo.${line.key}`)}
        </span>
      )}
    </span>
  );
}
