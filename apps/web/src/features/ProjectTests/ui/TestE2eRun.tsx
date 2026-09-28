import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { toErrorMessage } from '@shared/api/client';
import { useE2eRunSettled, useRunE2eTests, useStopE2eTests } from '@entities/ProjectTest';
import { caseRunSearch } from '../model/caseResults';
import { e2eRunOutcome } from '../model/e2eRunOutcome';
import { e2eRunChoice, type E2eRunChoice } from '../model/e2eRunChoice';
import type { TestE2eRunProps } from './TestE2eRun.types';
import styles from './ProjectTests.module.scss';

/** Раздел тестов; тип `string` — как у остальных ссылок из фич на страницы. */
const TESTS_ROUTE: string = '/tests';

/**
 * «Прогнать автотесты»: команда каркаса папки, запущенная панелью, — ноль
 * токенов, агента нет. Результаты ложатся на кейсы одной строкой истории.
 *
 * Кнопка закрыта, когда запускать нечего (нет файлов, каркас не узнан) или
 * когда идёт прогон агента: он пишет в те же файлы групп. Причина — в подсказке,
 * серая кнопка без причины читается как поломка.
 *
 * Итог — словами тестировщика (`e2eRunOutcome`): прошло или упало, какие тесты
 * без кейса, ссылка на запись истории. Сама команда — в раскрывашке вывода: в
 * строке хода она была шумом, а у Cypress и pytest несла ещё и путь отчёта.
 */
export function TestE2eRun({
  path,
  folder,
  run,
  environmentId,
  isAgentRunning,
  automation,
  group,
}: TestE2eRunProps) {
  const { t } = useTranslation();
  const start = useRunE2eTests(path);
  const stop = useStopE2eTests(path);
  useE2eRunSettled(path, run?.finishedAt);

  const isRunning = run?.status === 'running';
  // Тот же выбор, что у сервера, — и для всего набора, и для файлов группы:
  // группа с файлами вне папки e2e идёт своей командой проекта (F-324).
  const whole = e2eRunChoice({ folder, automation });
  const forGroup = group ? e2eRunChoice({ folder, automation, files: group.paths }) : undefined;
  const own = whole === 'own' || forGroup === 'own' ? automation : undefined;
  // Пустая папка без своей команды: сервер запустил бы её команду впустую —
  // отказ здесь строже сервера нарочно.
  const refusal = (choice: E2eRunChoice): string => {
    if (choice === 'none') return t('testsE2e.run.noFramework');
    if (choice === 'folder' && folder.specs === 0) return t('testsE2e.run.noSpecs');
    return '';
  };
  const busy = isAgentRunning ? t('testsE2e.run.agentBusy') : '';
  const blocked = refusal(whole) || busy;
  const groupBlocked =
    (forGroup && refusal(forGroup)) ||
    busy ||
    (group && group.files === 0 ? t('testsE2e.run.groupEmpty', group) : '');
  const launch = (groupId?: string) => {
    stop.reset();
    start.mutate({ environmentId, groupId });
  };
  const failure = start.error ?? stop.error;
  const outcome = e2eRunOutcome(run, t);

  return (
    <Stack gap="var(--spacing-2xs)" data-testid="tests-e2e-run">
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        {isRunning ? (
          <Button
            variant="danger"
            size="sm"
            leftIcon={<Icon name="stop" size={16} />}
            isLoading={stop.isPending}
            onClick={() => stop.mutate()}
          >
            {t('testsE2e.run.stop')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="check" size={16} />}
            title={blocked || t('testsE2e.run.hint')}
            disabled={Boolean(blocked)}
            isLoading={start.isPending}
            onClick={() => launch()}
          >
            {t('testsE2e.run.start')}
          </Button>
        )}
        {!isRunning && group && (
          <Button
            variant="ghost"
            size="sm"
            title={groupBlocked || t('testsE2e.run.groupHint', { ...group, count: group.files })}
            disabled={Boolean(groupBlocked)}
            onClick={() => launch(group.id)}
          >
            {t('testsE2e.run.group', group)}
          </Button>
        )}
        {isRunning && (
          <Typography variant="caption" color="subtle" as="span" role="status">
            {t('testsE2e.run.running')}
          </Typography>
        )}
      </Stack>

      {own && (
        <Typography variant="caption" color="subtle">
          {t('testsE2e.run.ownCommand', { command: own.command })}
        </Typography>
      )}

      {outcome && outcome.lines.length > 0 && (
        <Stack gap="var(--spacing-3xs)" role="status">
          {outcome.lines.map((line) => (
            <Typography key={line} variant="caption" color={outcome.tone}>
              {line}
            </Typography>
          ))}
          {outcome.runId && (
            <Link
              to={TESTS_ROUTE}
              search={caseRunSearch(path, outcome.runId)}
              className={styles.resultsRun}
            >
              {t('testsE2e.run.openRun')}
            </Link>
          )}
        </Stack>
      )}

      {run && (
        <details open={isRunning}>
          <summary>
            <Typography variant="caption" color="subtle" as="span">
              {t('testsE2e.run.log')}
            </Typography>
          </summary>
          <pre className={styles.log}>
            {`${t('testsE2e.run.command')}: ${run.command}\n\n${run.log || t('testsE2e.run.logEmpty')}`}
          </pre>
        </details>
      )}

      {failure && (
        <Typography variant="caption" color="danger" role="alert">
          {toErrorMessage(failure)}
        </Typography>
      )}
    </Stack>
  );
}
