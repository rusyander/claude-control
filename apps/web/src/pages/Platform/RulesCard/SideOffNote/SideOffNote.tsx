import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import styles from './SideOffNote.module.scss';
import type { SideOffNoteProps } from './SideOffNote.types';

/**
 * Надпись над колонкой, которую выбор «чьи правила действуют» снял с прогона.
 * Значения на ней остаются живыми и правятся: выбор меняет, что уходит в
 * прогон, а не то, что записано, — вернув «оба набора», человек найдёт всё на
 * месте.
 */
export function SideOffNote({ offBy }: SideOffNoteProps) {
  const { t } = useTranslation();
  if (!offBy) return null;
  return (
    <Typography
      variant="caption"
      color="warning"
      role="note"
      className={styles.sideOffNote}
      data-side-off-note={offBy}
    >
      {t('contourConfig.rules.sideOff', { choice: t(`contourConfig.rules.applies.${offBy}`) })}
    </Typography>
  );
}
