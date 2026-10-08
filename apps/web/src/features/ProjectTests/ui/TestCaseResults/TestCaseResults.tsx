import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { FLAKY_MIN_FLIPS, FLAKY_WINDOW } from '@agentdeck/contracts';
import { STATUS_TONE, useTestCaseHistory } from '@entities/ProjectTest';
import { reasonOf } from '../../model/caseResults';
import type { TestCaseResultsProps } from './TestCaseResults.types';
import styles from './TestCaseResults.module.scss';
import { caseRunSearch } from '../../model/caseRunSearch';
import { VISIBLE, TESTS_ROUTE } from './TestCaseResults.constants';

/**
 * История результатов кейса по прогонам — как «Results» у кейса в TestRail.
 *
 * Отвечает на вопрос, который задают, открыв покрасневший кейс: он красный
 * впервые, всегда или через раз? Строка — прогон: когда, итог, ссылка на
 * запись прогона и что сломалось одной строкой.
 */
export function TestCaseResults({ projectPath, groupId, caseId, runStamp }: TestCaseResultsProps) {
  // Дата — языком интерфейса, а не браузера: английская панель иначе
  // показывала русские даты (F-323).
  const { t, i18n } = useTranslation();
  const history = useTestCaseHistory(projectPath, groupId, caseId, runStamp);

  const header = (
    <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
      <Typography variant="body-sm" weight="medium">
        {t('tests.library.history.title')}
      </Typography>
      {history.data?.flaky.isFlaky && (
        <span
          title={t('tests.library.flakyHint', {
            flips: history.data.flaky.flips,
            runs: history.data.flaky.runs,
            window: FLAKY_WINDOW,
            minFlips: FLAKY_MIN_FLIPS,
          })}
        >
          <Badge tone="warning">{t('tests.library.flaky')}</Badge>
        </span>
      )}
    </Stack>
  );

  if (history.isPending) {
    return (
      <Stack gap="var(--spacing-2xs)">
        {header}
        <SkeletonList rows={2} />
      </Stack>
    );
  }
  if (history.isError) {
    return (
      <Stack gap="var(--spacing-2xs)">
        {header}
        <LoadErrorCard
          title={t('tests.library.history.loadError')}
          onRetry={() => void history.refetch()}
        />
      </Stack>
    );
  }

  const entries = history.data.entries.slice(0, VISIBLE);
  return (
    <Stack gap="var(--spacing-2xs)">
      {header}
      {entries.length === 0 ? (
        <Typography variant="caption" color="subtle">
          {t('tests.library.history.empty')}
        </Typography>
      ) : (
        <div className={styles.resultsScroll}>
          <table className={styles.resultsTable}>
            <thead>
              <tr>
                <th scope="col">{t('tests.library.history.columnDate')}</th>
                <th scope="col">{t('tests.library.history.columnStatus')}</th>
                <th scope="col">{t('tests.library.history.columnRun')}</th>
                <th scope="col">{t('tests.library.history.columnReason')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const reason = reasonOf(entry);
                return (
                  <tr key={entry.runId}>
                    <td>
                      <Typography variant="caption" as="span">
                        {new Date(entry.startedAt).toLocaleString(i18n.language)}
                      </Typography>
                    </td>
                    <td>
                      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                        <Badge tone={STATUS_TONE[entry.status]}>
                          {t(`projectTests.status.${entry.status}`)}
                        </Badge>
                        {entry.points > 1 && (
                          <Typography variant="caption" color="subtle" as="span">
                            {t('tests.library.history.points', { count: entry.points })}
                          </Typography>
                        )}
                      </Stack>
                    </td>
                    <td>
                      {/* Ссылка ведёт в историю прогонов с раскрытой записью:
                          там весь прогон — соседние кейсы, лог, вложения.
                          Проект — в ссылке: из чата раздел помнит другой. */}
                      <Link
                        to={TESTS_ROUTE}
                        search={caseRunSearch(projectPath, entry.runId)}
                        title={t('tests.library.history.openRun')}
                        className={styles.resultsRun}
                      >
                        {t(`tests.runs.mode.${entry.mode}`)}
                        {entry.release ? ` · ${entry.release}` : ''}
                      </Link>
                    </td>
                    <td>
                      {reason && (
                        <Typography
                          variant="caption"
                          color="subtle"
                          as="span"
                          className={styles.resultsReason}
                          title={reason.text}
                        >
                          {reason.step
                            ? t('tests.library.history.step', {
                                step: reason.step,
                                text: reason.text,
                              })
                            : reason.text}
                        </Typography>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Stack>
  );
}
