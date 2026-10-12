import { useTranslation } from 'react-i18next';
import { AREA_COLOR } from '../model/areas';
import { areaShares } from '../model/areaShares';
import type { ChangelogAreaBarProps } from './ChangelogAreaBar.types';
import styles from './ChangelogAreaBar.module.scss';

/**
 * Полоса «Что затронуто»: ширина сегмента — доля строк области в выпуске, под
 * ней легенда с названиями, файлами и строками. Полоса — картинка с общей
 * подписью, а точные числа читаются из легенды: цвет один не несёт смысла.
 */
export function ChangelogAreaBar({ areas }: ChangelogAreaBarProps) {
  const { t, i18n } = useTranslation();
  if (areas.length === 0) return null;
  const shares = areaShares(areas);
  const number = (n: number): string => n.toLocaleString(i18n.language);
  const label = (area: string): string => t(`changelog.areas.${area}`);
  const summary = areas
    .map((a) => `${label(a.area)}: +${number(a.insertions)} −${number(a.deletions)}`)
    .join('; ');

  return (
    <div className={styles.root}>
      <div className={styles.bar} role="img" aria-label={summary}>
        {shares.map((share) => (
          <span
            key={share.area}
            className={styles.segment}
            style={{ width: `${share.percent}%`, background: AREA_COLOR[share.area] }}
          />
        ))}
      </div>
      <ul className={styles.legend}>
        {areas.map((a) => (
          <li key={a.area} className={styles.legendItem}>
            <span className={styles.swatch} style={{ background: AREA_COLOR[a.area] }} />
            <span className={styles.areaName}>{label(a.area)}</span>
            <span className={styles.numbers}>
              <span className={styles.added}>+{number(a.insertions)}</span>{' '}
              <span className={styles.removed}>−{number(a.deletions)}</span>
              {' · '}
              {t('changelog.filesTotal', { files: number(a.files) })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
