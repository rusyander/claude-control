import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { RecordReply } from '@agentdeck/contracts/core/panel-api';
import { queryKeys } from '@shared/api/query-keys';
import { Button } from '@shared/ui/button';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { coreGet, failureOf, failureReason } from '@entities/CoreTask';
import { verdictLine } from '../../model/format';
import type { RecordPeekProps } from './RecordPeek.types';
import styles from './RecordPeek.module.scss';

/**
 * Ссылка на запись проверки (07:20): запись читается только по нажатию — у задачи их десятки, и
 * читать все при открытии ленты значило бы нагрузить ядро ради свёрнутых строк. Запрос несёт
 * задачу (`?task=`, F7): ядро отдаёт запись только в пределах задачи, на которую смотрит человек.
 */
export function RecordPeek({ taskId, recordId }: RecordPeekProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.core.record(recordId),
    queryFn: () => coreGet<RecordReply>('/records/:id', { id: recordId }, { task: taskId }),
    enabled: open,
    retry: false,
  });
  const failure = error ? failureOf(error) : null;
  return (
    <Stack gap="var(--spacing-3xs)" data-record-peek={recordId}>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-record-link={recordId}
      >
        {t('coreTimeline.check.record', { id: recordId })}
      </Button>
      {open && isLoading && (
        <Typography variant="caption" color="muted">
          {t('coreTimeline.check.recordLoading')}
        </Typography>
      )}
      {open && failure && (
        <Typography variant="caption" color="warning" data-record-failure={failure.status ?? 0}>
          {failure.status === 501
            ? t('coreTimeline.check.recordMissing')
            : t('coreTimeline.check.recordError', { reason: failureReason(failure) })}
        </Typography>
      )}
      {open && data && (
        <div className={styles.record} data-record-verdict={data.record.verdict.kind}>
          <Typography variant="caption">
            {t('coreTimeline.check.recordVerdict', { verdict: verdictLine(data.record.verdict) })}
          </Typography>
          <Typography variant="caption" color="muted">
            {t('coreTimeline.check.recordExit', { exit: data.record.exit ?? '—' })}
            {' · '}
            {t('coreTimeline.check.recordMs', { ms: data.record.ms })}
          </Typography>
          <Typography variant="caption" color="muted">
            {t('coreTimeline.check.recordArgv')}
          </Typography>
          <Typography variant="mono" as="code" className={styles.argv}>
            {data.record.argv.join(' ')}
          </Typography>
          {data.record.failing.length > 0 && (
            <>
              <Typography variant="caption" color="danger">
                {t('coreTimeline.check.recordFailing')}
              </Typography>
              <ul className={styles.list}>
                {data.record.failing.map((f) => (
                  <li key={`${f.file ?? ''}:${f.name}`}>
                    <Typography variant="caption" as="span">
                      {f.file ? `${f.file} — ${f.name}` : f.name}
                    </Typography>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Stack>
  );
}
