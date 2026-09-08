import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import {
  STATUS_TONE,
  useRefreshDefects,
  useStartTestRun,
  useTestCoverage,
} from '@entities/ProjectTest';
import type { ProjectTestCoverageItem } from '@agentdeck/contracts';
import styles from './TestsPage.module.scss';

/**
 * Покрытие требований и судьба дефектов.
 *
 * Список кейсов отвечает на «что мы проверяем». Дыру по нему не видно: кейса,
 * которого нет, в списке кейсов нет по определению. Эта вкладка — единственное
 * место, где виден обратный вопрос: требование, к которому не привязано ни
 * одного кейса, стоит первым и подписано словом «не покрыто».
 *
 * Вторая карточка — обратный ход от трекера: закрыт ли уже дефект, из-за
 * которого кейс красный. Статус кейса при этом не меняется никогда — его ставит
 * только прогон; трекер отвечает на «починили ли», а не на «работает ли».
 */
export function TestsCoverageTab({ projectPath }: { projectPath: string | undefined }) {
  const { t } = useTranslation();
  // Запрос применяется по кнопке, а не по каждой букве: каждый вызов — поход
  // в Jira, и матрица, пересобираемая на вводе, означала бы её обстрел.
  const [draft, setDraft] = useState('');
  const [jql, setJql] = useState('');
  const coverage = useTestCoverage(projectPath, jql);
  const defects = useRefreshDefects(projectPath);
  // «Покрыть кейсами» стоит на строке требования, а не в пульте прогона: это
  // единственное место, где видно, какое требование не покрыто ничем.
  const start = useStartTestRun(projectPath);

  const data = coverage.data;
  const items = data?.items ?? [];

  return (
    <Stack gap="var(--spacing-sm)">
      <Card padding="md">
        <Stack direction="row" gap="var(--spacing-sm)" align="end" wrap>
          <div className={styles.jqlField}>
            <TextField
              label={t('tests.coverage.jql')}
              value={draft}
              onChange={setDraft}
              placeholder={data?.jql ?? t('tests.coverage.jqlPlaceholder')}
              hint={t('tests.coverage.jqlHint')}
              isMono
            />
          </div>
          <Button
            variant="secondary"
            leftIcon={<Icon name="search" size={18} />}
            onClick={() => setJql(draft.trim())}
            disabled={coverage.isFetching}
          >
            {t('tests.coverage.apply')}
          </Button>
          <Button
            variant="ghost"
            leftIcon={<Icon name="refresh" size={18} />}
            onClick={() => defects.mutate()}
            disabled={defects.isPending}
          >
            {t('tests.coverage.refreshDefects')}
          </Button>
        </Stack>
      </Card>

      {defects.data && (
        <Card padding="md">
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('tests.coverage.defects')}
            </Typography>
            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              <Badge tone="neutral">
                {t('tests.coverage.defectsChecked', { count: defects.data.checked })}
              </Badge>
              <Badge tone="success">
                {t('tests.coverage.defectsClosed', { count: defects.data.closed })}
              </Badge>
            </Stack>
            {/* Ради этого списка кнопку и нажимают: дефект закрыт, а кейс всё
                ещё красный — значит, его пора перепроверить. */}
            {defects.data.recheck.length === 0 ? (
              <Typography variant="caption" color="subtle">
                {t('tests.coverage.recheckEmpty')}
              </Typography>
            ) : (
              <>
                <Typography variant="caption" color="subtle">
                  {t('tests.coverage.recheckHint')}
                </Typography>
                {/* Список без кнопки заканчивался тем, что человек шёл в пульт и
                    отмечал те же кейсы руками. Прогон стартует ровно по ним. */}
                <Stack direction="row">
                  <Button
                    variant="secondary"
                    size="sm"
                    leftIcon={<Icon name="refresh" size={16} />}
                    disabled={start.isPending}
                    title={t('tests.coverage.recheckRunHint')}
                    onClick={() =>
                      start.mutate({
                        mode: 'run',
                        caseIds: [...new Set(defects.data.recheck.map((item) => item.caseId))],
                      })
                    }
                  >
                    {t('tests.coverage.recheckRun', {
                      count: new Set(defects.data.recheck.map((item) => item.caseId)).size,
                    })}
                  </Button>
                </Stack>
                {defects.data.recheck.map((item) => (
                  <Stack
                    key={`${item.groupId}:${item.caseId}:${item.url}`}
                    direction="row"
                    gap="var(--spacing-2xs)"
                    align="center"
                    wrap
                  >
                    <Badge tone="warning">{item.key ?? t('tests.coverage.defect')}</Badge>
                    <Typography variant="body-sm" as="span">
                      {item.title}
                    </Typography>
                    <a
                      className={styles.runLink}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {t('tests.coverage.openDefect')}
                    </a>
                  </Stack>
                ))}
              </>
            )}
            {defects.data.skipped.map((reason) => (
              <Typography key={reason} variant="caption" color="subtle">
                {reason}
              </Typography>
            ))}
          </Stack>
        </Card>
      )}
      {defects.isError && (
        <Card padding="md">
          <Typography variant="caption" color="danger">
            {t('tests.coverage.defectsError')}
          </Typography>
        </Card>
      )}

      {coverage.isLoading && <SkeletonList rows={4} />}

      {data?.warning && (
        <Typography variant="caption" color="subtle">
          {data.warning}
        </Typography>
      )}

      {!coverage.isLoading && items.length === 0 && (
        <EmptyState
          icon="link"
          title={t('tests.coverage.empty')}
          text={t('tests.coverage.emptyHint')}
        />
      )}

      {items.map((item) => (
        <CoverageRow
          key={item.key}
          item={item}
          onCover={() =>
            start.mutate({
              mode: 'generate',
              source: 'requirement',
              sourceRef: item.url || item.key,
            })
          }
          isStarting={start.isPending}
        />
      ))}

      {/* Кейсы без единой ссылки на требование: не дыра в покрытии, а дыра в
          прослеживаемости — по ним нельзя ответить, зачем они существуют. */}
      {(data?.orphans.length ?? 0) > 0 && (
        <Card padding="md">
          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('tests.coverage.orphans', { count: data?.orphans.length ?? 0 })}
            </Typography>
            <Typography variant="caption" color="subtle">
              {t('tests.coverage.orphansHint')}
            </Typography>
            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              {(data?.orphans ?? []).slice(0, 40).map((one) => (
                <Badge key={`${one.groupId}:${one.caseId}`} tone={STATUS_TONE[one.status]}>
                  {one.title}
                </Badge>
              ))}
            </Stack>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

/** Цвет строки: не покрыто — красное, красные кейсы — предупреждение, иначе зелень. */
function toneOf(item: ProjectTestCoverageItem): 'danger' | 'warning' | 'success' {
  if (item.cases.length === 0) return 'danger';
  if (item.counts.failed > 0 || item.counts.blocked > 0) return 'warning';
  return 'success';
}

/** Строка матрицы: требование, его кейсы и чем закончился последний прогон. */
function CoverageRow({
  item,
  onCover,
  isStarting,
}: {
  item: ProjectTestCoverageItem;
  onCover: () => void;
  isStarting: boolean;
}) {
  const { t } = useTranslation();
  const isUncovered = item.cases.length === 0;

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          {/* Голое число рядом со словом «не покрыто» читается как что угодно —
              приоритет, номер строки, количество дефектов. Подписываем. */}
          <Badge tone={toneOf(item)}>
            {isUncovered
              ? t('tests.coverage.uncovered')
              : t('tests.coverage.cases', { count: item.cases.length })}
          </Badge>
          {item.url ? (
            <a className={styles.runLink} href={item.url} target="_blank" rel="noreferrer noopener">
              {item.key}
            </a>
          ) : (
            <Typography variant="mono" as="span">
              {item.key}
            </Typography>
          )}
          <Typography variant="body-sm" as="span">
            {item.title ?? ''}
          </Typography>
          {item.status && (
            <Typography variant="caption" color="subtle" as="span">
              {item.status}
            </Typography>
          )}
          {/* Кнопка стоит на строке требования, а не в пульте: запуск отсюда
              несёт агенту ключ задачи, поэтому кейсы приходят уже привязанными
              к ней — ради этого столбца матрица и существует. */}
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="plus" size={16} />}
            onClick={onCover}
            disabled={isStarting}
            title={t('projectTests.generateRequirementHint')}
          >
            {t('projectTests.generateRequirement')}
          </Button>
        </Stack>

        {isUncovered ? (
          <Typography variant="caption" color="subtle">
            {t('tests.coverage.uncoveredHint')}
          </Typography>
        ) : (
          <Stack direction="row" gap="var(--spacing-2xs)" wrap>
            {item.cases.map((one) => (
              <Badge key={`${one.groupId}:${one.caseId}`} tone={STATUS_TONE[one.status]}>
                {one.muted ? `${one.title} · ${t('tests.muted.short')}` : one.title}
              </Badge>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
