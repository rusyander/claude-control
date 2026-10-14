import { useTranslation } from 'react-i18next';
import { toGb } from '@entities/LocalModels';
import { Typography } from '@shared/ui/typography';
import { contextLabel, formatGb, quantTitle } from '../ModelSelects/optionText';
import styles from './ModelFacts.module.scss';
import type { ModelFactsProps } from './ModelFacts.types';

/**
 * Что получится на этой машине при выбранных квантовании и окне: скорость,
 * память, файл и замер. Скорость — всегда диапазоном и словом «оценка»: число из
 * формулы, поданное как замер, человек принял бы за обещание. Замер, снятый на
 * другом выборе, помечен рядом с числом.
 */
export function ModelFacts({ row }: ModelFactsProps) {
  const { t, i18n } = useTranslation();
  const { model, choiceFit: fit, installed, benchOn } = row;
  const locale = i18n.language;
  const [low, high] = fit.tokensPerSec;
  const bench = installed?.bench;
  const hasSpeed = fit.level !== 'none' && high > 0;
  const missingQuant = installed !== undefined && !row.quantInstalled;
  const toolsFailed = model.toolsProbe === 'failed';

  return (
    <div
      className={styles.island}
      role="group"
      aria-label={t('localModels.catalog.facts.group', { title: model.title })}
    >
      <Typography variant="caption" color="muted" weight="semibold">
        {t('localModels.catalog.facts.title')}
      </Typography>
      <dl className={styles.stats}>
        <div className={styles.stat}>
          <Typography as="dt" variant="caption" color="muted">
            {t('localModels.catalog.facts.speed')}
          </Typography>
          <dd className={`${styles.value} ${hasSpeed ? styles.speed : styles.dim}`}>
            {hasSpeed ? t('localModels.catalog.speed', { low, high }) : '—'}
          </dd>
          <Typography as="dd" variant="caption" color="muted">
            {t('localModels.catalog.speedEstimate')}
          </Typography>
        </div>
        <div className={styles.stat}>
          <Typography as="dt" variant="caption" color="muted">
            {t('localModels.catalog.facts.memory')}
          </Typography>
          <dd className={`${styles.value} ${styles.nowrap}`}>
            {t('localModels.catalog.facts.need', {
              need: formatGb(fit.needGb, locale),
              available: formatGb(fit.availableGb, locale),
            })}
          </dd>
          <Typography as="dd" variant="caption" color="muted">
            {fit.kvCache === 'q4_0'
              ? t('localModels.catalog.selects.kvQ4')
              : t('localModels.catalog.facts.contextOf', {
                  value: contextLabel(row.choice.context),
                })}
          </Typography>
        </div>
        <div className={styles.stat}>
          <Typography as="dt" variant="caption" color="muted">
            {t('localModels.catalog.facts.file')}
          </Typography>
          <dd className={`${styles.value} ${styles.nowrap}`}>
            {t('localModels.catalog.facts.gb', {
              value: formatGb(toGb(row.quant?.sizeBytes ?? model.sizeBytes), locale),
            })}
          </dd>
          <Typography as="dd" variant="caption" color="muted">
            {row.quant
              ? [
                  quantTitle(model, row.quant.id, t),
                  row.quant.source === 'ollama' ? t('localModels.catalog.selects.fromOllama') : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : ''}
          </Typography>
        </div>
        {bench ? (
          <div className={styles.stat}>
            <Typography as="dt" variant="caption" color="muted">
              {benchOn
                ? t('localModels.catalog.facts.benchOn', {
                    where: t(`localModels.catalog.measuredWhere.${benchOn}`),
                  })
                : t('localModels.catalog.facts.bench')}
            </Typography>
            <dd className={`${styles.value} ${styles.nowrap}`}>
              {t('localModels.catalog.facts.tps', { value: bench.tokensPerSec })}
            </dd>
            {bench.context !== undefined && bench.quant !== undefined ? (
              <Typography as="dd" variant="caption" color="muted">
                {t('localModels.catalog.measuredWith', {
                  context: contextLabel(bench.context),
                  quant: quantTitle(model, bench.quant, t),
                })}
              </Typography>
            ) : null}
            {row.benchStale ? (
              <Typography as="dd" variant="caption" color="warning">
                {t(`localModels.catalog.benchStale.${row.benchStale}`)}
              </Typography>
            ) : null}
          </div>
        ) : null}
      </dl>
      <div className={styles.notes}>
        {fit.reason ? (
          <Typography variant="body-sm" color={fit.reason === 'too-big' ? 'muted' : 'warning'}>
            {t(`localModels.catalog.reason.${fit.reason}`)}
          </Typography>
        ) : null}
        {missingQuant && row.quant ? (
          <Typography variant="body-sm" color="warning">
            {t('localModels.catalog.quantMissing', {
              quant: quantTitle(model, row.quant.id, t),
              quants: row.installedQuants.map((id) => quantTitle(model, id, t)).join(', '),
            })}
          </Typography>
        ) : null}
        {model.custom && !toolsFailed && model.toolsProbe !== 'ok' ? (
          <Typography variant="body-sm" color="muted">
            {t('localModels.catalog.custom.uncheckedHint')}
          </Typography>
        ) : null}
      </div>
    </div>
  );
}
