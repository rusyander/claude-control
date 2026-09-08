import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { SearchField } from '@shared/ui/search-field';
import { SelectField } from '@shared/ui/select-field';
import { IntegrationLinkRows, useIntegrationLinks } from '@entities/Integration';
import { TestSecretsModal } from './TestSecretsModal';
import type { ProjectTestsRunBarProps } from './ProjectTestsRunBar.types';
import styles from './ProjectTests.module.scss';

/**
 * Пульт прогона: что запустить, на чём и как оно идёт.
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
  environmentId,
  onEnvironmentChange,
}: ProjectTestsRunBarProps) {
  const { t } = useTranslation();
  const run = board.run;
  const isRunning = run?.status === 'running';
  const cases = board.active?.cases ?? [];
  // Веха живёт здесь, а не в состоянии страницы: её читает только запуск, и
  // пустая она означает не «без вехи», а «возьми тег git» — это решает сервер.
  const [release, setRelease] = useState('');
  const [isSecretsOpen, setSecretsOpen] = useState(false);

  // Какое окружение правят доступами: выбранное, а не выбрано ничего — то же,
  // которое возьмёт прогон. Иначе человек вводил бы пароль одному стенду, а
  // запускал на другом.
  const alive = board.environments.filter((item) => !item.archived);
  const environment = environmentId
    ? alive.find((item) => item.id === environmentId)
    : (alive.find((item) => item.isDefault) ?? alive[0]);

  // Внешний контекст показываем ТОЛЬКО чтением: правят его в разделе тестов и
  // в карточке проекта, а из чата важно одно — увидеть, куда уедут дефекты,
  // прежде чем запускать прогон.
  const links = useIntegrationLinks(board.path);
  const groupLink = board.activeId ? links.data?.groups?.[board.activeId] : undefined;
  const contextLink = groupLink ?? links.data?.project;

  // Сколько кейсов отбора ещё не в коде: это и есть работа режима
  // «автоматизировать», и число стоит на кнопке, а не выясняется отказом.
  const toAutomate = cases.filter(
    (item) =>
      (board.checked.length === 0 || board.checked.includes(item.id)) &&
      !item.archived &&
      item.automation?.status !== 'automated',
  ).length;

  const counts = {
    passed: cases.filter((item) => item.status === 'passed').length,
    failed: cases.filter((item) => item.status === 'failed').length,
    skipped: cases.filter((item) => item.status === 'skipped' || item.status === 'blocked').length,
    rest: cases.filter((item) => item.status === 'unknown' || item.status === 'running').length,
  };

  const base = {
    groupId: board.activeId || undefined,
    scope,
    environmentId: environmentId || undefined,
    release: release.trim() || undefined,
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

        {/* Веха прогона: `v1.4`, «спринт 12». Пусто — сервер подставит
            ближайший тег git, поэтому поле узкое и без обязательности: оно
            нужно там, где релиз называется не так, как тег. */}
        <div className={styles.release}>
          <SearchField
            label={t('tests.runs.release')}
            placeholder={t('tests.runs.releaseHint')}
            value={release}
            onChange={setRelease}
          />
        </div>

        {onEnvironmentChange && board.environments.length > 0 && (
          <SelectField
            label={t('tests.runs.environment')}
            value={environmentId ?? ''}
            onChange={onEnvironmentChange}
            options={[
              { value: '', label: t('tests.runs.environmentDefault') },
              ...board.environments
                .filter((item) => !item.archived)
                .map((item) => ({ value: item.id, label: item.title })),
            ]}
          />
        )}

        {/* Доступы стоят у выбора окружения, а не в настройках: пароль от
            стенда вспоминают ровно тогда, когда собираются на нём гонять.
            Правятся они у ТОГО окружения, которое сейчас выбрано, — второго
            места для одного и того же стенда быть не должно. */}
        {environment && (
          <Button
            variant="ghost"
            leftIcon={<Icon name="lock" size={18} />}
            title={t('tests.secrets.openHint', { environment: environment.title })}
            onClick={() => setSecretsOpen(true)}
          >
            {t('tests.secrets.open')}
          </Button>
        )}

        <Button
          variant="secondary"
          leftIcon={<Icon name="plus" size={18} />}
          disabled={isRunning}
          isLoading={board.isBusy && !isRunning}
          title={t('projectTests.generateHint')}
          onClick={() =>
            board.start({ mode: 'generate', ...base, autoAccept: board.autoAcceptDrafts })
          }
        >
          {t('projectTests.generate')}
        </Button>

        {/* Генерация по диффу — не другой режим, а другой ИСТОЧНИК: агенту дают
            прочитать изменения ветки вместо всего приложения. Сравнение по
            умолчанию считает сервер (`origin/main..HEAD`). */}
        <Button
          variant="ghost"
          leftIcon={<Icon name="branch" size={18} />}
          disabled={isRunning}
          title={t('projectTests.generateDiffHint')}
          onClick={() =>
            board.start({
              mode: 'generate',
              ...base,
              source: 'diff',
              autoAccept: board.autoAcceptDrafts,
            })
          }
        >
          {t('projectTests.generateDiff')}
        </Button>

        {/* Галочка стоит рядом с кнопкой генерации, а не в настройках: решение
            «смотреть предложения или нет» принимают в момент запуска. Права
            прогона она не меняет — библиотеку в любом случае пишет панель. */}
        <Stack direction="row" gap="var(--spacing-3xs)" align="center">
          <Toggle
            size="sm"
            checked={board.autoAcceptDrafts}
            onCheckedChange={board.setAutoAcceptDrafts}
            disabled={isRunning}
            aria-label={t('tests.drafts.auto')}
          />
          <Typography variant="caption" color="subtle" as="span" title={t('tests.drafts.autoHint')}>
            {t('tests.drafts.auto')}
          </Typography>
        </Stack>

        <Button
          variant="primary"
          leftIcon={<Icon name="check" size={18} />}
          disabled={isRunning || cases.length === 0}
          onClick={() =>
            board.start({
              mode: 'run',
              ...base,
              caseIds: board.checked.length > 0 ? board.checked : undefined,
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
          onClick={() => board.start({ mode: 'run', ...base, full: true })}
        >
          {t('projectTests.runFull')}
        </Button>

        {/* Отбор по диффу: гнать только то, чего касаются несохранённые правки.
            Считает его сервер по `codePaths` кейсов — панель лишь просит. */}
        <Button
          variant="ghost"
          leftIcon={<Icon name="branch" size={18} />}
          disabled={isRunning || cases.length === 0}
          title={t('tests.runs.changedOnlyHint')}
          onClick={() => board.start({ mode: 'run', ...base, changedOnly: true })}
        >
          {t('tests.runs.changedOnly')}
        </Button>

        {/* Исследование — не прогон по списку, а поиск того, чего в списке нет.
            Без хартии кнопка не активна: сессия без неё превращается в час
            блуждания по приложению, и поле пожелания здесь и есть хартия. */}
        <Button
          variant="ghost"
          leftIcon={<Icon name="search" size={18} />}
          disabled={isRunning || scope.trim().length === 0}
          title={scope.trim() ? t('projectTests.exploreHint') : t('projectTests.exploreNeedsScope')}
          onClick={() => board.start({ mode: 'explore', ...base })}
        >
          {t('projectTests.explore')}
        </Button>

        {/* Автоматизировать можно только то, чего ещё нет в коде, — и человек
            должен видеть, сколько это, ДО нажатия: иначе кнопка обещает работу
            над набором, который весь уже автоматизирован. */}
        <Button
          variant="ghost"
          leftIcon={<Icon name="scripts" size={18} />}
          disabled={isRunning || toAutomate === 0}
          title={t('projectTests.automateHint')}
          onClick={() =>
            board.start({
              mode: 'automate',
              ...base,
              caseIds: board.checked.length > 0 ? board.checked : undefined,
            })
          }
        >
          {t('projectTests.automate', { count: toAutomate })}
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
        {board.branch && (
          <Typography variant="caption" color="subtle" as="span">
            {t('tests.runs.branch', { branch: board.branch })}
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

      <IntegrationLinkRows link={contextLink} />

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

      {environment && (
        <TestSecretsModal
          isOpen={isSecretsOpen}
          onOpenChange={setSecretsOpen}
          path={board.path}
          environment={environment}
        />
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
