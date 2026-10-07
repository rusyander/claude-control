import { useTranslation } from 'react-i18next';
import type {
  GlobalLayerCaseResult,
  GlobalLayerMiss,
  GlobalLayerRow,
  GlobalLayerSide,
  GlobalLayerVerdict,
} from '@agentdeck/contracts';
import { Badge } from '@shared/ui/badge';
import type { BadgeTone } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import type { GlobalLayerTableProps } from './GlobalLayerTable.types';
import styles from './GlobalLayerCard.module.scss';

const VERDICT_TONE: Record<GlobalLayerVerdict, BadgeTone> = {
  panel: 'accent',
  global: 'info',
  equal: 'neutral',
};

const SIDES: readonly GlobalLayerSide[] = ['panel', 'global'];

/**
 * Таблица сит пары: на скольких случаях права каждая сторона и итог. Перенос
 * предлагается только туда, где копия хуже, — у равных переносить нечего.
 * Случаи с расхождением раскрываются под строкой: что сторона пропустила и что
 * отметила лишним, чтобы вердикт можно было проверить глазами, а не на веру.
 */
export function GlobalLayerTable({ rows, busy, onTransfer }: GlobalLayerTableProps) {
  const { t, i18n } = useTranslation();
  const en = i18n.language.startsWith('en');

  const missText = (miss: GlobalLayerMiss): string =>
    [
      miss.missed.length > 0
        ? t('settings.globalLayer.missed', { items: miss.missed.join(', ') })
        : '',
      miss.extra.length > 0
        ? t('settings.globalLayer.extra', { items: miss.extra.join(', ') })
        : '',
    ]
      .filter(Boolean)
      .join('; ');

  const caseLine = (item: GlobalLayerCaseResult) => (
    <li key={item.caseId} data-global-case={item.caseId}>
      <Typography variant="body-sm" as="span">
        {en ? item.title.en : item.title.ru}
      </Typography>
      {SIDES.map((side) => {
        const miss = item[side];
        if (!miss) return null;
        return (
          <Typography key={side} variant="caption" color="subtle" as="span" className={styles.miss}>
            {t(`settings.globalLayer.side.${side}`)} — {missText(miss)}
          </Typography>
        );
      })}
    </li>
  );

  const action = (row: GlobalLayerRow) => {
    if (row.verdict === 'equal') return null;
    // Хуже та копия, что проиграла: в неё и переносим лучшее.
    const direction = row.verdict === 'global' ? 'toPanel' : 'toGlobal';
    return (
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => onTransfer(direction, row.sieve)}
      >
        {t(`settings.globalLayer.${direction}`)}
      </Button>
    );
  };

  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('settings.globalLayer.sieve')}</th>
            <th scope="col">{t('settings.globalLayer.both')}</th>
            <th scope="col">{t('settings.globalLayer.panelOnly')}</th>
            <th scope="col">{t('settings.globalLayer.globalOnly')}</th>
            <th scope="col">{t('settings.globalLayer.neither')}</th>
            <th scope="col">{t('settings.globalLayer.verdict')}</th>
            <th scope="col">{t('settings.globalLayer.action')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const differing = row.cases.filter((item) => item.outcome !== 'both');
            return (
              <tr key={row.sieve} data-global-sieve={row.sieve} data-verdict={row.verdict}>
                <th scope="row">
                  <span>
                    {t(`settings.sieves.builtin.${row.sieve}`, { defaultValue: row.sieve })}
                  </span>
                  {differing.length > 0 && (
                    <details className={styles.cases}>
                      <summary>
                        {t('settings.globalLayer.cases', { count: differing.length })}
                      </summary>
                      <ul>{differing.map(caseLine)}</ul>
                    </details>
                  )}
                </th>
                <td>{row.both}</td>
                <td>{row.panelOnly}</td>
                <td>{row.globalOnly}</td>
                <td>{row.neither}</td>
                <td>
                  <Badge tone={VERDICT_TONE[row.verdict]}>
                    {t(`settings.globalLayer.verdictOf.${row.verdict}`)}
                  </Badge>
                </td>
                <td>{action(row)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
