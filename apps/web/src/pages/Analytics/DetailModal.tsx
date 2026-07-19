import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Modal } from '@shared/ui/modal';
import { Badge } from '@shared/ui/badge';
import { Card } from '@shared/ui/card';
import { formatCompact, formatMoney, formatNumber, formatPercent } from '@shared/lib/format-number';
import { DetailRow } from './DetailRow';
import type { DetailModalProps } from './DetailModal.types';
import styles from './AnalyticsPage.module.scss';

/**
 * Разбивка по одной строке графика. Данные берём из уже загруженной сводки,
 * а не отдельным запросом: всё нужное для детализации там есть, и лишний
 * поход на сервер только задержал бы открытие.
 */
export function DetailModal({ isOpen, onOpenChange, kind, id, analytics }: DetailModalProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const model = kind === 'model' ? analytics.byModel.find((item) => item.model === id) : undefined;
  const project =
    kind === 'project' ? analytics.byProject.find((item) => item.project === id) : undefined;

  const totals = model?.totals ?? project?.totals;
  const cost = model?.estimatedCost ?? project?.estimatedCost ?? 0;
  const title = model?.model ?? project?.displayName ?? id;

  // Сессии, относящиеся к выбранному проекту: для модели такой связи нет,
  // одна сессия может обращаться к нескольким моделям.
  const sessions =
    kind === 'project'
      ? analytics.recentSessions.filter((session) => session.project === id)
      : analytics.recentSessions.filter((session) => session.models.includes(id));

  const share = totals && analytics.overall.total > 0 ? totals.total / analytics.overall.total : 0;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} title={title} size="md">
      {totals ? (
        <Stack gap="var(--spacing-md)">
          {kind === 'project' && (
            <Typography variant="mono" color="subtle">
              {project?.project}
            </Typography>
          )}

          <Card padding="md">
            <Stack>
              <DetailRow
                label={t('analytics.totalTokens')}
                value={formatCompact(totals.total, locale)}
                detail={`${formatPercent(share, locale)} ${t('analytics.ofTotal')}`}
              />
              <DetailRow
                label={t('analytics.requests')}
                value={formatNumber(totals.requests, locale)}
              />
              <DetailRow
                label={t('analytics.inputTokens')}
                value={formatCompact(totals.input, locale)}
              />
              <DetailRow
                label={t('analytics.outputTokens')}
                value={formatCompact(totals.output, locale)}
              />
              <DetailRow
                label={t('analytics.cacheRead')}
                value={formatCompact(totals.cacheRead, locale)}
              />
              <DetailRow
                label={t('analytics.cacheCreation')}
                value={formatCompact(totals.cacheCreation, locale)}
              />
              <DetailRow
                label={t('analytics.estimatedCost')}
                value={formatMoney(cost, locale)}
                detail={t('analytics.estimatedCostShort')}
              />
              {project && (
                <DetailRow
                  label={t('analytics.sessionsCount')}
                  value={formatNumber(project.sessions, locale)}
                  detail={new Date(project.lastActivity).toLocaleString(locale)}
                />
              )}
            </Stack>
          </Card>

          {sessions.length > 0 && (
            <Stack gap="var(--spacing-xs)">
              <Typography variant="body-sm" weight="medium">
                {t('analytics.recentSessions')}
              </Typography>

              <Card padding="none">
                <Stack>
                  {sessions.slice(0, 10).map((session) => (
                    <Stack
                      key={session.sessionId}
                      direction="row"
                      align="center"
                      justify="between"
                      gap="var(--spacing-sm)"
                      className={styles.sessionRow}
                    >
                      <Stack gap="var(--spacing-3xs)">
                        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                          <Typography variant="body-sm" as="span">
                            {kind === 'project' ? session.models.join(', ') : session.displayName}
                          </Typography>
                          {session.isActive && (
                            <Badge tone="success" withDot>
                              {t('analytics.sessionActive')}
                            </Badge>
                          )}
                        </Stack>
                        <Typography variant="caption" color="subtle" as="span">
                          {new Date(session.lastActivity).toLocaleString(locale)}
                        </Typography>
                      </Stack>

                      <Typography variant="body-sm" color="muted" as="span">
                        {formatCompact(session.totals.total, locale)}
                      </Typography>
                    </Stack>
                  ))}
                </Stack>
              </Card>
            </Stack>
          )}
        </Stack>
      ) : (
        <Typography color="subtle">{t('analytics.noData')}</Typography>
      )}
    </Modal>
  );
}
