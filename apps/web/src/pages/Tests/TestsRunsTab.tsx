import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { CHAT_ROUTE } from '@shared/config/routes';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { STATUS_TONE, runExportUrl, useTestRun, useTestRuns } from '@entities/ProjectTest';
import { BaselineViewer } from '@features/TestBaselines';
import { TestsRunPublish } from './TestsRunPublish';
import { formatRunDuration } from './model/reportMetrics';
import type { TestsRunsTabProps } from './TestsRunsTab.types';
import styles from './TestsPage.module.scss';

/**
 * История прогонов и разбор одного из них.
 *
 * Список отвечает на «что вообще происходило», раскрытая запись — на «почему
 * этот кейс красный». Поэтому запись тянется отдельным запросом: результаты по
 * поинтам с заметками и вложениями весят на порядок больше сводки, и грузить их
 * для полусотни строк истории значит платить за то, что никто не откроет.
 *
 * Прогон агента ссылается на разговор: там лежит полный транскрипт с командами
 * и выводом, и это единственное место, где видно, ЧТО именно агент делал.
 */
export function TestsRunsTab({ projectPath, groups, isRunning }: TestsRunsTabProps) {
  const { t } = useTranslation();
  const runs = useTestRuns(projectPath, true, isRunning);
  const [openId, setOpenId] = useState('');
  const run = useTestRun(projectPath, openId || undefined);
  // Сверка эталонов открывается по КЕЙСУ: у одного кейса несколько точек, и
  // разбирают их подряд, а не по одной из разных мест.
  const [baselineCase, setBaselineCase] = useState('');

  const titleOf = (groupId: string, caseId: string): string =>
    groups.find((group) => group.id === groupId)?.cases.find((item) => item.id === caseId)?.title ??
    caseId;

  if (runs.isLoading) return <SkeletonList rows={4} />;

  const list = runs.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState icon="history" title={t('tests.runs.empty')} text={t('tests.runs.emptyHint')} />
    );
  }

  return (
    <Stack gap="var(--spacing-sm)">
      {list.map((record) => {
        const isOpen = record.id === openId;
        return (
          <Card key={record.id} padding="md" isRaised={isOpen}>
            <Stack gap="var(--spacing-2xs)">
              {/* aria-controls связывает заголовок с телом записи: без него
                  «раскрыто» слышно, а ЧТО раскрылось — нет. */}
              <button
                type="button"
                className={styles.runHead}
                aria-expanded={isOpen}
                aria-controls={`run-body-${record.id}`}
                onClick={() => setOpenId(isOpen ? '' : record.id)}
              >
                <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                  <Badge tone={record.status === 'error' ? 'danger' : 'neutral'}>
                    {t(`tests.runs.mode.${record.mode}`)}
                  </Badge>
                  <Badge tone="info">{t(`tests.runs.actor.${record.actor}`)}</Badge>
                  <Typography variant="body-sm" as="span">
                    {new Date(record.startedAt).toLocaleString()}
                  </Typography>
                  {record.branch && (
                    <Typography variant="caption" color="subtle" as="span">
                      {record.branch}
                    </Typography>
                  )}
                  {record.environmentId && <Badge tone="neutral">{record.environmentId}</Badge>}
                </Stack>
              </button>

              <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                <Typography variant="caption" color="success" as="span">
                  {t('tests.runs.passed', { count: record.summary.passed })}
                </Typography>
                <Typography variant="caption" color="danger" as="span">
                  {t('tests.runs.failed', { count: record.summary.failed })}
                </Typography>
                <Typography variant="caption" color="warning" as="span">
                  {t('tests.runs.skipped', {
                    count: record.summary.skipped + record.summary.blocked,
                  })}
                </Typography>
                <Typography variant="caption" color="subtle" as="span">
                  {t('tests.runs.duration', {
                    text: formatRunDuration(record.startedAt, record.finishedAt),
                  })}
                </Typography>
                {Boolean(record.tokens) && (
                  <Typography variant="caption" color="subtle" as="span">
                    {t('tests.runs.tokens', { count: record.tokens ?? 0 })}
                  </Typography>
                )}
                {Boolean(record.costUsd) && (
                  <Typography variant="caption" color="subtle" as="span">
                    {t('tests.runs.cost', { value: (record.costUsd ?? 0).toFixed(2) })}
                  </Typography>
                )}
                {record.sessionId && (
                  <Link
                    to={CHAT_ROUTE}
                    search={{ id: record.sessionId }}
                    className={styles.runLink}
                  >
                    {t('tests.runs.openChat')}
                  </Link>
                )}
                {/* Отчёт файлом — для тех, у кого панели нет: приёмка, заказчик,
                    соседняя команда. Обычная ссылка, имя файла даёт сервер. */}
                <a className={styles.runLink} href={runExportUrl(projectPath, record.id, 'md')}>
                  {t('tests.runs.exportMd')}
                </a>
                <a className={styles.runLink} href={runExportUrl(projectPath, record.id, 'csv')}>
                  {t('tests.runs.exportCsv')}
                </a>
                {/* PDF — то, что уходит приёмке и заказчику: markdown им не
                    посылают. Рисует его браузер на этой машине, поэтому ссылка
                    может привести к честному отказу, а не к файлу. */}
                <a className={styles.runLink} href={runExportUrl(projectPath, record.id, 'pdf')}>
                  {t('tests.runs.exportPdf')}
                </a>
              </Stack>

              {record.error && (
                <Typography variant="caption" color="danger">
                  {record.error}
                </Typography>
              )}

              {isOpen && run.data && (
                <Stack
                  id={`run-body-${record.id}`}
                  gap="var(--spacing-2xs)"
                  className={styles.runBody}
                >
                  {/* Публикация — внутри раскрытой записи: её делают, посмотрев
                      на результат, а не пробегая список глазами. */}
                  <TestsRunPublish projectPath={projectPath} runId={record.id} />

                  {run.data.results.length === 0 && (
                    <Typography variant="caption" color="subtle">
                      {t('tests.runs.noResults')}
                    </Typography>
                  )}
                  {run.data.results.map((result) => (
                    <Stack key={result.pointId} gap="var(--spacing-3xs)" className={styles.result}>
                      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                        <Badge tone={STATUS_TONE[result.status]}>
                          {t(`projectTests.status.${result.status}`)}
                        </Badge>
                        <Typography variant="body-sm" as="span">
                          {titleOf(result.groupId, result.caseId)}
                        </Typography>
                        {result.params &&
                          Object.entries(result.params).map(([name, value]) => (
                            <Badge key={name} tone="neutral">{`${name}=${value}`}</Badge>
                          ))}
                        {result.durationMs !== undefined && (
                          <Typography variant="caption" color="subtle" as="span">
                            {t('tests.runs.pointDuration', {
                              seconds: Math.round(result.durationMs / 1000),
                            })}
                          </Typography>
                        )}
                      </Stack>
                      {result.note && (
                        <Typography variant="caption" color="subtle">
                          {result.note}
                        </Typography>
                      )}
                      {(result.attachments ?? []).length > 0 && (
                        <Stack direction="row" gap="var(--spacing-3xs)" align="center" wrap>
                          {(result.attachments ?? []).map((file) => (
                            <Badge key={file} tone="neutral">
                              {file}
                            </Badge>
                          ))}
                          {/* Снимки есть — значит есть с чем сверять эталон. */}
                          <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={<Icon name="image" size={16} />}
                            onClick={() => setBaselineCase(result.caseId)}
                          >
                            {t('tests.baseline.open')}
                          </Button>
                        </Stack>
                      )}
                      {(result.defects ?? []).length > 0 && (
                        <Stack direction="row" gap="var(--spacing-3xs)" wrap>
                          {(result.defects ?? []).map((url) => (
                            <Badge key={url} tone="danger">
                              {url}
                            </Badge>
                          ))}
                        </Stack>
                      )}
                    </Stack>
                  ))}
                </Stack>
              )}
            </Stack>
          </Card>
        );
      })}

      <BaselineViewer
        isOpen={Boolean(baselineCase)}
        onOpenChange={(next) => !next && setBaselineCase('')}
        projectPath={projectPath}
        caseId={baselineCase || undefined}
      />
    </Stack>
  );
}
