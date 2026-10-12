import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@shared/lib/formatDateTime';
import { Typography } from '@shared/ui/typography';
import { RunInputSection } from './RunInputSection';
import type { RunInputRunsProps } from './RunInputs.types';
import styles from './RunInputs.module.scss';

/** Прогоны звена столбцом: шапка (когда, чем вели) и разделы входа дословно. */
export function RunInputRuns({ runs }: RunInputRunsProps) {
  const { t, i18n } = useTranslation();
  return (
    <ol className={styles.runs} data-received-runs>
      {runs.map((run) => (
        <li key={run.startedAt} className={styles.run} data-received-run>
          <div className={styles.meta}>
            <Typography variant="body-sm" as="span">
              {t('chat.cascade.hub.received.run', {
                when: formatDateTime(new Date(run.startedAt).toISOString(), i18n.language),
              })}
            </Typography>
            <Typography variant="caption" color="subtle" as="span">
              {t('chat.cascade.hub.received.model', {
                model: run.model ?? t('chat.cascade.hub.received.cliDefault'),
              })}
            </Typography>
            <Typography variant="caption" color="subtle" as="span">
              {t('chat.cascade.hub.received.effort', {
                effort: run.effort ?? t('chat.cascade.hub.received.cliDefault'),
              })}
            </Typography>
            {run.permissionMode && (
              <Typography variant="caption" color="subtle" as="span">
                {t('chat.cascade.hub.received.mode', { mode: run.permissionMode })}
              </Typography>
            )}
          </div>
          <RunInputSection label={t('chat.cascade.hub.received.prompt')} text={run.prompt} />
          {run.appendSystemPrompt && (
            <RunInputSection
              label={t('chat.cascade.hub.received.append')}
              text={run.appendSystemPrompt}
            />
          )}
          {run.systemPrompt && (
            <RunInputSection
              label={t('chat.cascade.hub.received.contour')}
              text={run.systemPrompt}
            />
          )}
          {run.platformArgs && (
            <RunInputSection
              label={t('chat.cascade.hub.received.flags')}
              text={run.platformArgs.join(' ')}
            />
          )}
        </li>
      ))}
    </ol>
  );
}
