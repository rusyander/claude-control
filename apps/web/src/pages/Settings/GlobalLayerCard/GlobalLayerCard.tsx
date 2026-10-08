import { useTranslation } from 'react-i18next';
import type { GlobalLayerSide, GlobalLayerVerdict } from '@agentdeck/contracts';
import { useCompareGlobalLayer } from '@entities/GlobalLayer';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { useGlobalLayerTransfer } from '../model/useGlobalLayerTransfer';
import { GlobalLayerTable } from '../GlobalLayerTable/GlobalLayerTable';
import { GlobalLayerProposal } from '../GlobalLayerProposal/GlobalLayerProposal';
import type { GlobalLayerCardProps } from './GlobalLayerCard.types';
import styles from './GlobalLayerCard.module.scss';
import { SIDES } from './GlobalLayerCard.constants';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Карточка пары «панель ↔ глобальный слой»: когда сверяли, кто лучше и по каким
 * ситам, таблица с расхождениями, перенос и предложение для слоя. Итог словами
 * стоит над таблицей — ради него карточку и открывают, а цифры его объясняют.
 */
export function GlobalLayerCard({ pair }: GlobalLayerCardProps) {
  const { t, i18n } = useTranslation();
  const compare = useCompareGlobalLayer();
  const transfer = useGlobalLayerTransfer();
  const title = i18n.language.startsWith('en') ? pair.title.en : pair.title.ru;

  const runCompare = () =>
    compare.mutate(pair.id, { onError: (error) => toast.error(toErrorMessage(error)) });

  const sieveNames = (verdict: GlobalLayerVerdict): string =>
    pair.rows
      .filter((row) => row.verdict === verdict)
      .map((row) => t(`settings.sieves.builtin.${row.sieve}`, { defaultValue: row.sieve }))
      .join('; ');

  const status = (): string => {
    if (pair.comparing) return t('settings.globalLayer.comparing');
    if (!pair.comparedAt) return t('settings.globalLayer.never');
    return t('settings.globalLayer.comparedAt', {
      at: new Date(pair.comparedAt).toLocaleString(),
      count: pair.cases,
    });
  };

  const sideLine = (side: GlobalLayerSide) => {
    const state = pair[side];
    if (!state) return null;
    const name = t(`settings.globalLayer.side.${side}`);
    if (!state.ok) {
      return (
        <Typography key={side} variant="body-sm" color="danger">
          {t('settings.globalLayer.sideError', { side: name, error: state.error ?? '' })}
        </Typography>
      );
    }
    return (
      <Typography key={side} variant="body-sm" color={state.failing ? 'default' : 'success'}>
        {state.failing
          ? t('settings.globalLayer.sideFailing', { side: name, count: state.failing })
          : t('settings.globalLayer.sideGreen', { side: name })}
      </Typography>
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-md)" data-global-pair={pair.id}>
        <div className={styles.header}>
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body" weight="medium">
              {title}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('settings.globalLayer.intro')}
            </Typography>
          </Stack>
          <Button
            size="sm"
            variant="secondary"
            disabled={pair.comparing || compare.isPending}
            onClick={runCompare}
          >
            {t('settings.globalLayer.compare')}
          </Button>
        </div>

        {pair.changed && (
          <div className={styles.changed} role="status" data-global-changed>
            <Typography variant="body-sm">
              {t('settings.globalLayer.changed', {
                sides: pair.changed.sides
                  .map((side) => t(`settings.globalLayer.side.${side}`))
                  .join(', '),
                at: new Date(pair.changed.at).toLocaleString(),
              })}
            </Typography>
            <Button size="sm" variant="primary" disabled={pair.comparing} onClick={runCompare}>
              {t('settings.globalLayer.compare')}
            </Button>
          </div>
        )}

        <Stack gap="var(--spacing-3xs)" aria-live="polite">
          <Typography variant="body-sm" color="subtle">
            {status()}
          </Typography>
          {SIDES.map(sideLine)}
          {pair.error && (
            <Typography variant="body-sm" color="danger">
              {pair.error}
            </Typography>
          )}
        </Stack>

        {pair.rows.length > 0 && (
          <Stack gap="var(--spacing-xs)" data-global-summary>
            {sieveNames('global') && (
              <Typography variant="body-sm" weight="medium">
                {t('settings.globalLayer.summaryGlobal', { sieves: sieveNames('global') })}
              </Typography>
            )}
            {sieveNames('panel') && (
              <Typography variant="body-sm" weight="medium">
                {t('settings.globalLayer.summaryPanel', { sieves: sieveNames('panel') })}
              </Typography>
            )}
            {!sieveNames('global') && !sieveNames('panel') && (
              <Typography variant="body-sm">{t('settings.globalLayer.summaryEqual')}</Typography>
            )}
            <GlobalLayerTable
              rows={pair.rows}
              busy={transfer.isPending}
              onTransfer={(direction, sieve) => transfer.start(pair.id, { direction, sieve })}
            />
            <Typography variant="caption" color="subtle">
              {t('settings.globalLayer.transferHint')}
            </Typography>
          </Stack>
        )}

        {pair.proposalFiles > 0 && (
          <GlobalLayerProposal pairId={pair.id} files={pair.proposalFiles} />
        )}

        <Stack gap="var(--spacing-3xs)">
          {SIDES.map((side) => (
            <Typography key={side} variant="caption" color="subtle" className={styles.files}>
              {t('settings.globalLayer.files', {
                side: t(`settings.globalLayer.side.${side}`),
                files: (side === 'panel' ? pair.panelFiles : pair.globalFiles).join(', '),
              })}
            </Typography>
          ))}
        </Stack>
      </Stack>
    </Card>
  );
}
