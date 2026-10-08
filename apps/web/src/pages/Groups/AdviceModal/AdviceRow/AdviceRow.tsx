import type { AdviceRowProps } from './AdviceRow.types';
import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { VERDICT_TONE } from './AdviceRow.constants';
import { Typography } from '@shared/ui/typography';
import styles from './AdviceRow.module.scss';
import { runsCode } from '../../lib/runsCode';
import { readable } from '../../lib/readable';

export function AdviceRow({ item, isPicked, onToggle }: AdviceRowProps) {
  const { t } = useTranslation();
  const verdict = (
    <Badge tone={VERDICT_TONE[item.verdict]}>{t(`groupSources.verdict_${item.verdict}`)}</Badge>
  );
  const name = (
    <Typography variant="body-sm" weight="medium" as="span">
      {item.id}
    </Typography>
  );

  return (
    <li className={styles.row}>
      {item.verdict === 'keep' ? (
        <div className={styles.head}>
          <span className={styles.spacer} aria-hidden="true" />
          {name}
          {verdict}
          <Typography variant="caption" color="subtle" as="span">
            {t('groupSources.adviceKeep')}
          </Typography>
        </div>
      ) : (
        <label className={styles.head}>
          <input type="checkbox" checked={isPicked} onChange={onToggle} />
          {name}
          {verdict}
        </label>
      )}
      <Typography variant="body-sm" color="muted" className={styles.reason}>
        {item.reason}
      </Typography>
      {item.verdict === 'ours' && item.replacement && (
        <Typography variant="caption" color="subtle" className={styles.reason}>
          {t('groupSources.adviceOursWith', { id: item.replacement })}
        </Typography>
      )}
      {item.verdict === 'improve' && item.replacement && (
        <details className={styles.replacement} open={runsCode(item)}>
          <summary>
            <Typography variant="caption" color="subtle" as="span">
              {runsCode(item)
                ? t('groupSources.adviceReplacementRuns')
                : t('groupSources.adviceReplacement')}
            </Typography>
          </summary>
          <pre className={styles.code}>{readable(item.replacement)}</pre>
        </details>
      )}
    </li>
  );
}
