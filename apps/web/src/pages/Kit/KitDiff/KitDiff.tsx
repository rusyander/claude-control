import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { DIFF_LINE_PREFIX } from '@shared/config/diff-line-prefix';
import type { KitDiffProps } from './KitDiff.types';
import styles from './KitDiff.module.scss';

/** Построчная разница «глобальный → набор»: добавленное в наборе — плюсом, чего в нём нет — минусом. */
export function KitDiff({ lines }: KitDiffProps) {
  const { t } = useTranslation();
  if (!lines) {
    return (
      <Typography variant="body-sm" color="subtle">
        {t('kit.editor.diffTooBig')}
      </Typography>
    );
  }
  if (!lines.some((line) => line.kind !== 'ctx')) {
    return (
      <Typography variant="body-sm" color="subtle">
        {t('kit.editor.noDiff')}
      </Typography>
    );
  }
  return (
    <div className={styles.diff} role="region" aria-label={t('kit.editor.diffLabel')} tabIndex={0}>
      {lines.map((line, index) => (
        // Строки диффа без своего идентификатора; список статичен — индекс устойчив.
        <div key={index} className={styles.diffLine} data-kind={line.kind}>
          <span className={styles.diffSign}>{DIFF_LINE_PREFIX[line.kind]}</span>
          <span className={styles.diffText}>{line.text}</span>
        </div>
      ))}
    </div>
  );
}
