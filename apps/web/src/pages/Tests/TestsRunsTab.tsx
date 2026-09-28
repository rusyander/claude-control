import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { CHAT_ROUTE } from '@shared/config/routes';
import { serverFieldText } from '@shared/config/i18n';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import {
  STATUS_TONE,
  runExportUrl,
  useStartTestRun,
  useTestRun,
  useTestRuns,
} from '@entities/ProjectTest';
import { BaselineViewer } from '@features/TestBaselines';
import { TestsRunPublish } from './TestsRunPublish';
import { TestsRunDiff } from './TestsRunDiff';
import { TestsRunsOriginFilter } from './TestsRunsOriginFilter';
import { queryView } from './model/queryView';
import { linkedRunToFollow } from './model/runLink';
import { visibleRuns, runLabelKeys, type RunOriginFilter } from './model/runOrigin';
import { formatRunDuration, isUnproven, redCases, runTally } from './model/reportMetrics';
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
export function TestsRunsTab({ projectPath, groups, isRunning, openRunId }: TestsRunsTabProps) {
  // Дата — языком интерфейса, а не браузера: английская панель иначе
  // показывала русские даты (F-323).
  const { t, i18n } = useTranslation();
  const runs = useTestRuns(projectPath, true, isRunning);
  const [openId, setOpenId] = useState(openRunId ?? '');
  // Пришли по ссылке из истории кейса — запись раскрыта; довести до неё
  // взгляд, иначе раскрытый прогон может оказаться далеко ниже экрана. Один
  // раз на ссылку: перечитанный список не должен снова её раскрывать.
  const followed = useRef('');
  useEffect(() => {
    const target = linkedRunToFollow(openRunId, followed.current, Boolean(runs.data));
    if (!target) return;
    followed.current = target;
    setOpenId(target);
    document.getElementById(`run-card-${target}`)?.scrollIntoView({ block: 'start' });
  }, [openRunId, runs.data]);
  const run = useTestRun(projectPath, openId || undefined);
  // Сверка эталонов открывается по КЕЙСУ: у одного кейса несколько точек, и
  // разбирают их подряд, а не по одной из разных мест.
  const [baselineCase, setBaselineCase] = useState('');
  // Регрессионный кейс заводят прямо у провала: там лежит и заметка, и снимки —
  // всё, из чего агенту собирать шаги воспроизведения.
  const start = useStartTestRun(projectPath);
  const [origin, setOrigin] = useState<RunOriginFilter>('all');

  const titleOf = (groupId: string, caseId: string): string =>
    groups.find((group) => group.id === groupId)?.cases.find((item) => item.id === caseId)?.title ??
    caseId;

  // Упавший запрос — отказ с повтором, а не «прогонов ещё нет»: пустота при
  // живой истории зовёт запускать прогон, а не повторить запрос.
  const view = queryView(runs, (items) => items.length === 0);
  if (view === 'loading') return <SkeletonList rows={4} />;
  if (view === 'failed') return <LoadErrorCard onRetry={() => void runs.refetch()} />;

  const all = runs.data ?? [];
  const { list, showFilter, origin: shownOrigin } = visibleRuns(all, origin);
  if (view === 'empty') {
    return (
      <EmptyState icon="history" title={t('tests.runs.empty')} text={t('tests.runs.emptyHint')} />
    );
  }

  return (
    <Stack gap="var(--spacing-sm)">
      {/* Автотесты панели и отчёт CI — оба импорт junit; отбор разводит их,
          когда в истории есть и те и другие. */}
      {showFilter && <TestsRunsOriginFilter value={shownOrigin} onChange={setOrigin} />}
      {list.map((record) => {
        const isOpen = record.id === openId;
        const tally = runTally(record);
        const label = runLabelKeys(record);
        return (
          <Card key={record.id} id={`run-card-${record.id}`} padding="md" isRaised={isOpen}>
            <Stack gap="var(--spacing-2xs)">
              {/* aria-controls связывает заголовок с телом записи: без него
                  «раскрыто» слышно, а ЧТО раскрылось — нет. Тело есть только у
                  раскрытой и загруженной записи — ссылка на отсутствующий id
                  была бы битой. */}
              <button
                type="button"
                className={styles.runHead}
                aria-expanded={isOpen}
                aria-controls={isOpen && run.data ? `run-body-${record.id}` : undefined}
                onClick={() => setOpenId(isOpen ? '' : record.id)}
              >
                <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                  <Badge tone={record.status === 'error' ? 'danger' : 'neutral'}>
                    {t(label.mode)}
                  </Badge>
                  <Badge tone="info">{t(label.actor)}</Badge>
                  {tally.state && (
                    <Badge tone={tally.state === 'running' ? 'info' : 'warning'}>
                      {t(`tests.runs.state.${tally.state}`)}
                    </Badge>
                  )}
                  <Typography variant="body-sm" as="span">
                    {new Date(record.startedAt).toLocaleString(i18n.language)}
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
                {/* Генерация кейсы не проходит: её нули — не итог, а зелёное
                    «пройдено: 0» рядом с красным «провалено: 0» читалось
                    прогоном, который ничего не нашёл. */}
                {tally.counted && (
                  <Typography variant="caption" color="success" as="span">
                    {t('tests.runs.passed', { count: tally.passed })}
                  </Typography>
                )}
                {tally.counted && (
                  <Typography variant="caption" color="danger" as="span">
                    {t('tests.runs.failed', { count: tally.failed })}
                  </Typography>
                )}
                {tally.blocked > 0 && (
                  <Typography variant="caption" color="danger" as="span">
                    {t('tests.runs.blocked', { count: tally.blocked })}
                  </Typography>
                )}
                {tally.counted && (
                  <Typography variant="caption" color="warning" as="span">
                    {t('tests.runs.skipped', { count: tally.skipped })}
                  </Typography>
                )}
                {tally.open > 0 && (
                  <Typography variant="caption" color="subtle" as="span">
                    {t('tests.runs.open', { count: tally.open })}
                  </Typography>
                )}
                <Typography variant="caption" color="subtle" as="span">
                  {t('tests.runs.duration', {
                    text: formatRunDuration(record.startedAt, record.finishedAt, t),
                  })}
                </Typography>
                {/* Итог генерации: сводка по кейсам у неё пустая — она их не
                    проходит, — и без этой строки запись выглядела бы прогоном,
                    который ничего не сделал. */}
                {record.draft && (
                  <Typography variant="caption" color="subtle" as="span">
                    {t('tests.runs.draftProposed', { count: record.draft.proposed })}
                  </Typography>
                )}
                {record.draft?.auto && (
                  <Typography variant="caption" color="warning" as="span">
                    {t('tests.runs.draftAccepted', { count: record.draft.accepted })}
                  </Typography>
                )}
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
                  {serverFieldText(record, 'error')}
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

                  <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                    {/* Красное этого прогона уже названо — выбирать кейсы руками
                        в пульте не нужно. Работает и на первом прогоне, которому
                        сравнивать себя не с чем. */}
                    {redCases(run.data).length > 0 && (
                      <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<Icon name="refresh" size={16} />}
                        disabled={isRunning || start.isPending}
                        title={t('tests.diff.rerunHint')}
                        onClick={() => start.mutate({ mode: 'run', caseIds: redCases(run.data) })}
                      >
                        {t('tests.diff.rerun', { count: redCases(run.data).length })}
                      </Button>
                    )}
                  </Stack>
                  <TestsRunDiff projectPath={projectPath} runId={record.id} />

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
                        {/* Провал без доказательства — не результат, а
                            впечатление. Результат при этом остаётся: терять
                            полчаса работы агента из-за формальности дороже. */}
                        {isUnproven(result) && (
                          <Badge tone="warning">{t('tests.evidence.missing')}</Badge>
                        )}
                        {result.failure?.step !== undefined && (
                          <Badge tone="neutral">
                            {t('tests.evidence.step', { count: result.failure.step })}
                          </Badge>
                        )}
                        {result.failure?.retry === 'flaky' && (
                          <Badge tone="warning">{t('tests.evidence.flaky')}</Badge>
                        )}
                        {result.failure?.retry === 'confirmed' && (
                          <Badge tone="neutral">{t('tests.evidence.confirmed')}</Badge>
                        )}
                        {/* Зелёный только на повторе раннера: признак числом,
                            слова — из словаря (прежде русская фраза в заметке). */}
                        {(result.flakyAttempts ?? 0) > 0 && (
                          <Badge tone="warning">
                            {t('tests.evidence.retryPass', { attempts: result.flakyAttempts })}
                          </Badge>
                        )}
                      </Stack>
                      {result.note && (
                        <Typography variant="caption" color="subtle">
                          {result.note}
                        </Typography>
                      )}
                      {/* Разбор провала: ожидание именно на том шаге, где
                          разошлось, и что вышло. Без него «провалился» нельзя
                          ни воспроизвести, ни завести дефектом. */}
                      {(result.failure?.expected || result.failure?.actual) && (
                        <Typography variant="caption" color="subtle">
                          {t('tests.evidence.detail', {
                            expected: result.failure.expected ?? '—',
                            actual: result.failure.actual ?? '—',
                          })}
                        </Typography>
                      )}
                      {result.failure?.retryNote && (
                        <Typography variant="caption" color="warning">
                          {t('tests.evidence.retryNote', { text: result.failure.retryNote })}
                        </Typography>
                      )}
                      {/* Провал без кейса, который его ловит, повторится. Кнопка
                          отдаёт агенту сам провал — кейс, прогон и заметку, — а
                          не просит человека пересказать его в пожелании. */}
                      {result.status === 'failed' && (
                        <Stack direction="row" gap="var(--spacing-3xs)" align="center" wrap>
                          <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={<Icon name="plus" size={16} />}
                            disabled={isRunning || start.isPending}
                            title={t('projectTests.generateRegressionHint')}
                            onClick={() =>
                              start.mutate({
                                mode: 'generate',
                                source: 'defect',
                                groupId: result.groupId,
                                sourceCase: {
                                  groupId: result.groupId,
                                  caseId: result.caseId,
                                  runId: record.id,
                                },
                              })
                            }
                          >
                            {t('projectTests.generateRegression')}
                          </Button>
                        </Stack>
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
