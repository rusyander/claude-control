import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { JobProgress, toGb } from '@entities/LocalModels';
import { ModelFacts } from '../ModelFacts/ModelFacts';
import { ModelSelects } from '../ModelSelects/ModelSelects';
import { formatGb, quantTitle } from '../ModelSelects/optionText';
import styles from './ModelRow.module.scss';
import type { ModelRowProps } from './ModelRow.types';
import { FIT_TONE } from './ModelRow.constants';

/**
 * Карточка модели из четырёх частей, одинаково разложенных во всём списке:
 * кто это (название, метки, влезает ли) · кнопки · расчёт на этой машине ·
 * настройки запуска. Всё, что сказано про память и скорость, — про ВЫБРАННЫЕ
 * квантование и окно, а не про умолчание каталога.
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
  onChoose,
}: ModelRowProps) {
  const { t, i18n } = useTranslation();
  const { model, choiceFit: fit, installed, job, serverJob } = row;
  const running = job?.state === 'running';
  const importOnly = !installed && row.importable;
  const canDownload = !row.quantInstalled && !running && !importOnly && fit.allowed;
  const toolsFailed = model.toolsProbe === 'failed';

  return (
    <article
      className={`${styles.card} ${row.recommended ? styles.recommended : ''}`}
      aria-label={model.title}
    >
      <div className={styles.head}>
        <div className={styles.identity}>
          <div className={styles.titleLine}>
            <Typography variant="body-lg" weight="semibold">
              {model.title}
            </Typography>
            <Typography variant="mono" color="muted">
              {model.tag}
            </Typography>
          </div>
          <div className={styles.badges}>
            <Badge tone={FIT_TONE[fit.level]} withDot>
              {t(`localModels.catalog.fit.${fit.level}`)}
            </Badge>
            {row.recommended ? (
              <Badge tone="accent">{t('localModels.catalog.recommended')}</Badge>
            ) : null}
            <Badge tone="info">{t(`localModels.catalog.kind.${model.coding}`)}</Badge>
            {model.custom ? (
              <Badge tone="neutral">{t('localModels.catalog.custom.badge')}</Badge>
            ) : null}
            {model.custom && model.toolsProbe !== 'ok' ? (
              <Badge tone={toolsFailed ? 'danger' : 'warning'}>
                {toolsFailed
                  ? t('localModels.catalog.custom.failed')
                  : t('localModels.catalog.custom.unchecked')}
              </Badge>
            ) : null}
            {inUse ? <Badge tone="success">{t('localModels.catalog.inUse')}</Badge> : null}
          </div>
        </div>

        <div className={styles.actions}>
          {importOnly && !running ? (
            <Button
              size="sm"
              variant="primary"
              onClick={onImport}
              title={t('localModels.catalog.importHint')}
            >
              {t('localModels.catalog.import')}
            </Button>
          ) : null}
          {canDownload ? (
            <Button
              size="sm"
              variant={row.recommended ? 'primary' : 'secondary'}
              leftIcon={<Icon name="plus" />}
              isLoading={busy.pull}
              onClick={onPull}
            >
              {row.quant
                ? t('localModels.catalog.downloadQuant', {
                    quant: quantTitle(model, row.quant.id, t),
                    size: formatGb(toGb(row.quant.sizeBytes), i18n.language),
                  })
                : t('localModels.catalog.download')}
            </Button>
          ) : null}
          {installed && row.quantInstalled && fit.agentReady && !inUse ? (
            <Button size="sm" variant="primary" isLoading={busy.connect} onClick={onConnect}>
              {t('localModels.catalog.use')}
            </Button>
          ) : null}
          {installed && row.quantInstalled ? (
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
          {installed || model.custom ? (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Icon name="trash" />}
              aria-label={t('localModels.catalog.remove')}
              onClick={onRemove}
            />
          ) : null}
        </div>
      </div>

      {job && (running || job.state === 'failed' || job.state === 'cancelled') ? (
        <JobProgress job={job} {...(running ? { onCancel: () => onCancel(job.id) } : {})} />
      ) : null}
      {serverJob && (serverJob.state === 'running' || serverJob.state === 'failed') ? (
        // Без «Отменить»: перезапуск сервера на полпути не прервать — модель осталась бы ни на старых, ни на новых настройках.
        <JobProgress job={serverJob} />
      ) : null}

      <div className={styles.islands}>
        <div className={`${styles.island} ${styles.factsIsland}`}>
          <ModelFacts row={row} />
        </div>
        <div className={`${styles.island} ${styles.settingsIsland}`}>
          <ModelSelects row={row} onChoose={onChoose} />
        </div>
      </div>
    </article>
  );
}
