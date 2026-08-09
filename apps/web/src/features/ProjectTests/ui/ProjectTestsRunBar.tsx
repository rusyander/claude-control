import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { SearchField } from '@shared/ui/search-field';
import type { TestsBoard } from '../model/useTestsBoard';
import styles from './ProjectTests.module.scss';

/**
 * Пульт прогона: что запустить и как оно идёт.
 *
 * Пока прогон идёт, кнопки запуска не прячутся, а гаснут: исчезающая панель
 * меняет высоту содержимого, и список кейсов под ней прыгает ровно в тот
 * момент, когда по нему следят за галочками.
 *
 * Лог показывается только во время прогона и сразу после него — это хвост
 * вывода агента, а не история: история лежит в транскрипте сессии.
 */
export function ProjectTestsRunBar({
  board,
  scope,
  onScopeChange,
}: {
  board: TestsBoard;
  scope: string;
  onScopeChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const run = board.run;
  const isRunning = run?.status === 'running';
  const cases = board.active?.cases ?? [];

  const counts = {
    passed: cases.filter((item) => item.status === 'passed').length,
    failed: cases.filter((item) => item.status === 'failed').length,
    skipped: cases.filter((item) => item.status === 'skipped').length,
    rest: cases.filter((item) => item.status === 'unknown' || item.status === 'running').length,
  };

  return (
    <Stack gap="var(--spacing-xs)" className={styles.bar}>
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        {/* Поле пожелания — без подписи сверху: подпись увела бы кнопки на
            вторую строку, а пульт должен читаться одной. Что сюда писать,
            сказано плейсхолдером. */}
        <div className={styles.scope}>
          <SearchField
            label={t('projectTests.scope')}
            placeholder={t('projectTests.scopeHint')}
            value={scope}
            onChange={onScopeChange}
          />
        </div>

        <Button
          variant="secondary"
          leftIcon={<Icon name="plus" size={18} />}
          disabled={isRunning}
          isLoading={board.isBusy && !isRunning}
          title={t('projectTests.generateHint')}
          onClick={() =>
            board.start({ mode: 'generate', groupId: board.activeId || undefined, scope })
          }
        >
          {t('projectTests.generate')}
        </Button>

        <Button
          variant="primary"
          leftIcon={<Icon name="check" size={18} />}
          disabled={isRunning || cases.length === 0}
          onClick={() =>
            board.start({
              mode: 'run',
              groupId: board.activeId || undefined,
              caseIds: board.checked.length > 0 ? board.checked : undefined,
              scope,
            })
          }
        >
          {board.checked.length > 0
            ? t('projectTests.runSelected', { count: board.checked.length })
            : t('projectTests.run')}
        </Button>

        <Button
          variant="secondary"
          leftIcon={<Icon name="refresh" size={18} />}
          disabled={isRunning || cases.length === 0}
          title={t('projectTests.runFullHint')}
          onClick={() =>
            board.start({ mode: 'run', groupId: board.activeId || undefined, scope, full: true })
          }
        >
          {t('projectTests.runFull')}
        </Button>

        {isRunning && (
          <Button variant="danger" leftIcon={<Icon name="stop" size={18} />} onClick={board.stop}>
            {t('projectTests.stop')}
          </Button>
        )}
      </Stack>

      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        {cases.length > 0 && (
          <Typography variant="caption" color="subtle" as="span">
            {t('projectTests.counts', counts)}
          </Typography>
        )}
        {run && (
          <Badge tone={badgeTone(run.status)}>
            {t(runKey(run.status, run.mode), { error: run.error ?? '' })}
          </Badge>
        )}
        {board.error && (
          <Typography variant="caption" color="danger" as="span">
            {board.error}
          </Typography>
        )}
      </Stack>

      <Typography variant="caption" color="subtle">
        {t('projectTests.fullAccessNote')}
      </Typography>

      {/* Кнопки этого окна отдают формат агенту сами, а просьба из чата — нет.
          Единственное, что читает КАЖДЫЙ разговор, — CLAUDE.md проекта; туда
          соглашение и вписывается, но только по явному нажатию: файл чужой. */}
      {board.hasConvention ? (
        <Typography variant="caption" color="success">
          {t('projectTests.conventionOn')}
        </Typography>
      ) : (
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Typography
            variant="caption"
            color="warning"
            as="span"
            title={t('projectTests.conventionOffText')}
          >
            {t('projectTests.conventionOff')}
          </Typography>
          <Button
            variant="ghost"
            size="sm"
            title={t('projectTests.conventionInstallText')}
            onClick={board.installConvention}
          >
            {t('projectTests.conventionInstall')}
          </Button>
        </Stack>
      )}

      {run && (
        <details open={isRunning}>
          <summary>
            <Typography variant="caption" color="subtle" as="span">
              {t('projectTests.log')}
            </Typography>
          </summary>
          <pre className={styles.log}>{run.log || t('projectTests.logEmpty')}</pre>
        </details>
      )}
    </Stack>
  );
}

/** Подпись прогона одним ключом словаря: вложенные тернарники здесь запрещены. */
function runKey(status: string, mode: string): string {
  if (status === 'running') {
    return mode === 'generate' ? 'projectTests.runGenerate' : 'projectTests.running';
  }
  if (status === 'stopped') return 'projectTests.runStopped';
  if (status === 'error') return 'projectTests.runError';
  return 'projectTests.runDone';
}

function badgeTone(status: string): 'info' | 'success' | 'danger' | 'warning' {
  if (status === 'running') return 'info';
  if (status === 'done') return 'success';
  if (status === 'error') return 'danger';
  return 'warning';
}
