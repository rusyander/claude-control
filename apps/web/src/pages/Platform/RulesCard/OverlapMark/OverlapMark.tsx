import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import styles from './OverlapMark.module.scss';
import type { OverlapMarkProps } from './OverlapMark.types';
import { winnerKey } from '../../lib/winnerKey';
import { conflictTone } from '../../lib/conflictTone';

/**
 * Отметка «пересекается» под строкой правила (баг 11в), на обеих колонках.
 *
 * Матрица под колонками говорила о спорах, но строки, которых они касаются,
 * стояли без отметки — человек не видел, что правило контура и наше задевают
 * одно и то же, пока не дочитывал карточку до конца. Кто берёт верх называет
 * сервер (`winner`); сторону, снятую выбором «чьи правила действуют», — тоже он
 * (`offBy`), и тогда спор в прогоне не случается вовсе.
 */
export function OverlapMark({ cell, what }: OverlapMarkProps) {
  const { t } = useTranslation();
  if (!cell) return null;
  const winner = winnerKey(cell);

  return (
    <Stack
      gap="var(--spacing-3xs)"
      className={styles.overlap}
      data-overlap={cell.id}
      data-overlap-off={cell.offBy ?? ''}
    >
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
        <Badge tone={cell.offBy ? 'neutral' : conflictTone(cell.level)}>
          {t('contourConfig.overlap.badge')}
        </Badge>
        <Typography variant="caption" color="muted" as="span">
          {t('contourConfig.overlap.with', { what })}
        </Typography>
      </Stack>
      {(cell.offBy || winner) && (
        <Typography variant="caption" color="muted" as="span" className="prose">
          {cell.offBy ? t(`contourConfig.offBy.${cell.offBy}`) : winner && t(winner)}
        </Typography>
      )}
    </Stack>
  );
}
