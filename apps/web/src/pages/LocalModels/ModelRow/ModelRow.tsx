import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { JobProgress, toGb } from '@entities/LocalModels';
import styles from './ModelRow.module.scss';
import type { ModelRowProps } from './ModelRow.types';
import { FIT_TONE } from './ModelRow.constants';

/**
 * Строка каталога. Скорость — всегда диапазоном и словом «оценка»: число из
 * формулы, поданное как замер, человек принял бы за обещание. Замер на этой
 * машине показывается рядом, когда он есть.
 */
export function ModelRow({
  row,
  inUse,
  serverReady,
  busy,
  onPull,
  onImport,
  onConnect,
  onBench,
  onRemove,
  onCancel,
}: ModelRowProps) {
  const { t } = useTranslation();
  const { model, fit, installed, job, benchOn } = row;
  const running = job?.state === 'running';
  const usable = fit.level !== 'none';
  const [low, high] = fit.tokensPerSec;
  const tokensPerSec = installed?.bench?.tokensPerSec;
  let measured = '';
  if (tokensPerSec !== undefined)
    measured = benchOn
      ? t('localModels.catalog.measuredOn', {
          value: tokensPerSec,
          where: t(`localModels.catalog.measuredWhere.${benchOn}`),
        })
      : t('localModels.catalog.measured', { value: tokensPerSec });

  return (
    <div className={styles.modelRow}>
      <Stack gap="var(--spacing-2xs)" flex={1} minWidth={0}>
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography weight="semibold">{model.title}</Typography>
          {row.recommended ? (
            <Badge tone="accent">{t('localModels.catalog.recommended')}</Badge>
          ) : null}
          <Badge tone="info">{t(`localModels.catalog.kind.${model.coding}`)}</Badge>
          <Badge tone={FIT_TONE[fit.level]} withDot>
            {t(`localModels.catalog.fit.${fit.level}`)}
          </Badge>
          {inUse ? <Badge tone="success">{t('localModels.catalog.inUse')}</Badge> : null}
        </Stack>
        <Typography variant="mono" color="muted">
          {model.tag}
        </Typography>
        <Typography variant="body-sm" color="muted">
          {[
            t('localModels.catalog.size', { size: toGb(model.sizeBytes) }),
            usable
              ? t('localModels.catalog.contextLine', { value: Math.round(fit.context / 1024) })
              : '',
            t('localModels.catalog.need', { need: Math.round(fit.needGb * 10) / 10 }),
            usable && high > 0
              ? `${t('localModels.catalog.speed', { low, high })} (${t('localModels.catalog.speedEstimate')})`
              : '',
            measured,
          ]
            .filter(Boolean)
            // Перенос — только между частями: внутри «61.4 ток/с» косая черта
            // иначе разрывала бы единицу измерения.
            .map((part, index) => (
              <Fragment key={part}>
                {index > 0 ? ' · ' : ''}
                <span className={styles.metaPart}>{part}</span>
              </Fragment>
            ))}
        </Typography>
        {fit.reason ? (
          <Typography variant="caption" color={fit.reason === 'too-big' ? 'muted' : 'warning'}>
            {t(`localModels.catalog.reason.${fit.reason}`)}
          </Typography>
        ) : null}
        {job && (running || job.state === 'failed' || job.state === 'cancelled') ? (
          <JobProgress job={job} {...(running ? { onCancel: () => onCancel(job.id) } : {})} />
        ) : null}
      </Stack>

      <Stack
        direction="row"
        gap="var(--spacing-xs)"
        wrap
        justify="end"
        className={styles.rowActions}
      >
        {!installed && !running && row.importable ? (
          <Button
            size="sm"
            variant="primary"
            onClick={onImport}
            title={t('localModels.catalog.importHint')}
          >
            {t('localModels.catalog.import')}
          </Button>
        ) : null}
        {!installed && !running && !row.importable && usable ? (
          <Button
            size="sm"
            variant={row.recommended ? 'primary' : 'secondary'}
            leftIcon={<Icon name="plus" />}
            isLoading={busy.pull}
            onClick={onPull}
          >
            {t('localModels.catalog.download')}
          </Button>
        ) : null}
        {installed && fit.agentReady && !inUse ? (
          <Button size="sm" variant="primary" isLoading={busy.connect} onClick={onConnect}>
            {t('localModels.catalog.use')}
          </Button>
        ) : null}
        {installed ? (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Icon name="analytics" />}
            isLoading={busy.bench}
            disabled={!serverReady}
            onClick={onBench}
          >
            {t('localModels.catalog.bench')}
          </Button>
        ) : null}
        {installed ? (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="trash" />}
            aria-label={t('localModels.catalog.remove')}
            onClick={onRemove}
          />
        ) : null}
      </Stack>
    </div>
  );
}
