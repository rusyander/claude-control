import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type { ProjectTestQuarantineSuggestion } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { useBulkTestCases, useTestQuarantine } from '@entities/ProjectTest';
import styles from './TestsPage.module.scss';
import { serverFieldText } from '@shared/config/i18n';

/**
 * Карантин и устаревание.
 *
 * Карантин без срока годности — это тихое удаление кейса, а набор, который никто
 * не пересматривает, за полгода расходится с приложением. Карточка отвечает на
 * оба вопроса числами: сколько зелёных подряд у выключенного кейса и насколько
 * требование новее кейса.
 *
 * Ни одно предложение не применяется само — жмёт человек, и жмёт обычное
 * массовое действие. Причина карантина обязательна: через месяц она
 * единственное, по чему можно понять, чего этот карантин ждал.
 */
export function TestsQuarantineCard({ projectPath }: { projectPath: string | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const report = useTestQuarantine(projectPath);
  const bulk = useBulkTestCases(projectPath);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  if (report.isLoading) return <SkeletonList rows={2} />;
  const data = report.data;
  if (!data) return undefined;

  const isEmpty = data.lift.length === 0 && data.quarantine.length === 0 && data.stale.length === 0;

  /** Открыть кейс в библиотеке — тем же адресом, которым на кейс ссылается поиск. */
  const openCase = (groupId: string, caseId: string): void => {
    void navigate({ to: '.', search: { id: `${groupId}:${caseId}` } });
  };

  const keyOf = (item: { groupId: string; caseId: string }): string =>
    `${item.groupId}:${item.caseId}`;

  const reasonOf = (item: ProjectTestQuarantineSuggestion): string =>
    reasons[keyOf(item)] ?? item.reason ?? '';

  const row = (item: ProjectTestQuarantineSuggestion, action: 'mute' | 'unmute') => {
    const reason = reasonOf(item);
    return (
      <Stack key={keyOf(item)} gap="var(--spacing-3xs)" className={styles.failureRow}>
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <Badge tone={action === 'unmute' ? 'success' : 'warning'}>
            {action === 'unmute' ? item.greenStreak : `${item.stability}%`}
          </Badge>
          <button
            type="button"
            className={styles.runHead}
            onClick={() => openCase(item.groupId, item.caseId)}
          >
            <Typography variant="body-sm" as="span">
              {item.title}
            </Typography>
          </button>
          <Typography variant="mono" color="subtle" as="span">
            {item.caseId}
          </Typography>
        </Stack>
        <Typography variant="caption" color="subtle">
          {serverFieldText(item, 'message')}
        </Typography>
        {action === 'unmute' && item.muteReason && (
          <Typography variant="caption" color="subtle">
            {t('tests.quarantine.was', { reason: item.muteReason })}
          </Typography>
        )}
        <Stack direction="row" gap="var(--spacing-2xs)" align="end" wrap>
          {action === 'mute' && (
            <TextField
              label={t('tests.quarantine.reason')}
              hint={t('tests.quarantine.reasonHint')}
              value={reason}
              onChange={(next) => setReasons((current) => ({ ...current, [keyOf(item)]: next }))}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={bulk.isPending || (action === 'mute' && !reason.trim())}
            onClick={() =>
              bulk.mutate({
                groupId: item.groupId,
                caseIds: [item.caseId],
                action,
                value: action === 'mute' ? reason.trim() : undefined,
              })
            }
          >
            {t(`tests.quarantine.${action}`)}
          </Button>
        </Stack>
      </Stack>
    );
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium">
          {t('tests.quarantine.title')}
        </Typography>
        <Typography variant="caption" color="subtle">
          {t('tests.quarantine.hint', {
            streak: data.thresholds.greenStreak,
            stability: data.thresholds.stability,
          })}
        </Typography>

        {isEmpty && (
          <Typography variant="caption" color="success">
            {t('tests.quarantine.clean')}
          </Typography>
        )}

        {data.lift.length > 0 && (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium">
              {t('tests.quarantine.liftTitle', { count: data.lift.length })}
            </Typography>
            {data.lift.slice(0, 20).map((item) => row(item, 'unmute'))}
          </Stack>
        )}

        {data.quarantine.length > 0 && (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium">
              {t('tests.quarantine.muteTitle', { count: data.quarantine.length })}
            </Typography>
            {data.quarantine.slice(0, 20).map((item) => row(item, 'mute'))}
          </Stack>
        )}

        {/* Расхождение с требованием — не замечание к кейсу, а повод его
            перечитать: правит его человек глазами, кнопки здесь быть не может. */}
        {data.stale.length > 0 && (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium">
              {t('tests.quarantine.staleTitle', { count: data.stale.length })}
            </Typography>
            {data.stale.slice(0, 20).map((item) => (
              <Stack
                key={`${item.groupId}:${item.caseId}:${item.key}`}
                direction="row"
                gap="var(--spacing-2xs)"
                align="center"
                wrap
                className={styles.failureRow}
              >
                <button
                  type="button"
                  className={styles.runHead}
                  onClick={() => openCase(item.groupId, item.caseId)}
                >
                  <Typography variant="body-sm" as="span">
                    {item.title}
                  </Typography>
                </button>
                <Typography variant="caption" color="warning" as="span">
                  {t('tests.quarantine.stale', { key: item.key, days: item.days })}
                </Typography>
                {item.url && (
                  <a
                    className={styles.runLink}
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {item.key}
                  </a>
                )}
              </Stack>
            ))}
          </Stack>
        )}

        {/* Трекер недоступен — это половина ответа, а не ошибка: предложения по
            карантину считаются по истории прогонов и без него. */}
        {data.warning && (
          <Typography variant="caption" color="subtle">
            {serverFieldText(data, 'warning')}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
