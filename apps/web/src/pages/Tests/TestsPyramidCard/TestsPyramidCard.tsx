import { useTranslation } from 'react-i18next';
import type { ProjectTestPyramidCount } from '@agentdeck/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { percentOf, useTestPyramid } from '@entities/ProjectTest';
import { pyramidRows, type PyramidRow } from '../model/pyramidRows';
import styles from './TestsPyramidCard.module.scss';

/**
 * Пирамида тестов: модульные и интеграционные рядом с e2e.
 *
 * Главное здесь — честность «не известно». Сервер считает слой, только если
 * его каркас назван самим проектом, и делит модульные с интеграционными, только
 * если проект их помечает; карточка это и говорит словами, вместо нуля, который
 * читался бы как «тестов нет».
 */
export function TestsPyramidCard({ projectPath }: { projectPath: string | undefined }) {
  const { t } = useTranslation();
  const pyramid = useTestPyramid(projectPath);

  if (pyramid.isLoading) return <SkeletonList rows={2} />;
  const data = pyramid.data;
  // Упавший подсчёт — отказ с повтором, а не пропавшая карточка: без неё
  // отчёт выглядел так, будто пирамиды у проекта нет вовсе (F-305).
  if (!data && pyramid.isError) {
    return (
      <LoadErrorCard title={t('tests.pyramid.title')} onRetry={() => void pyramid.refetch()} />
    );
  }
  if (!data) return undefined;

  const rows = pyramidRows(data);
  const widest = Math.max(1, ...rows.map((row) => row.count?.tests ?? 0));

  const countText = (count: ProjectTestPyramidCount): string =>
    `${t('tests.pyramid.tests', { count: count.tests })} ${t('tests.pyramid.files', { count: count.files })}`;

  const line = (row: PyramidRow) => (
    <Stack key={row.layer} gap="var(--spacing-3xs)" className={styles.failureRow}>
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
        <Typography variant="body-sm" weight="medium" as="span">
          {t(`tests.pyramid.layer.${row.layer}`)}
        </Typography>
        <Typography variant="caption" color={row.count ? 'default' : 'subtle'} as="span">
          {row.count ? countText(row.count) : t(`tests.pyramid.unknown.${row.layer}`)}
        </Typography>
        {row.dir && (
          <Typography variant="mono" color="subtle" as="span">
            {row.dir}
          </Typography>
        )}
      </Stack>
      {row.count && (
        <div className={styles.stack}>
          <span
            className={`${styles.stackPart} ${styles.stackPassed}`}
            style={{ width: `${percentOf(row.count.tests, widest)}%` }}
          />
        </div>
      )}
      {row.count && row.count.dynamic > 0 && (
        <Typography variant="caption" color="subtle">
          {t('tests.pyramid.dynamic', { count: row.count.dynamic })}
        </Typography>
      )}
    </Stack>
  );

  return (
    <Card padding="md" data-testid="tests-pyramid-card">
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" justify="between" wrap>
          <Typography variant="body-sm" weight="medium">
            {t('tests.pyramid.title')}
          </Typography>
          <Button
            variant="ghost"
            size="sm"
            isLoading={pyramid.isFetching}
            onClick={() => void pyramid.refetch()}
          >
            {t('tests.pyramid.recount')}
          </Button>
        </Stack>
        <Typography variant="caption" color="subtle">
          {t('tests.pyramid.hint')}
        </Typography>
        {rows.map(line)}
        <Typography variant="caption" color="subtle">
          {data.frameworks.length > 0
            ? t('tests.pyramid.frameworks', {
                list: data.frameworks.map((item) => `${item.name} (${item.source})`).join(', '),
              })
            : t('tests.pyramid.noFramework')}
        </Typography>
        {data.frameworks.length > 0 && !data.split && (
          <Typography variant="caption" color="subtle">
            {t('tests.pyramid.unsplit')}
          </Typography>
        )}
        {data.truncated && (
          <Typography variant="caption" color="warning">
            {t('tests.pyramid.truncated')}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
