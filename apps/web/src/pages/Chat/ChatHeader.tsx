import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { HELP_ROUTE } from '@shared/config/routes';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { formatSpend } from '@shared/lib/format';
import { AgentsPanel } from '@features/AgentsPanel';
import { ChatModelPicker } from '@features/ChatModelPicker';
import { ProjectRunnerControls } from '@features/ProjectRunner';
import { ProjectGitControls } from '@features/ProjectGit';
import { formatTime } from './lib/formatTime';
import type { ChatHeaderProps } from './ChatHeader.types';
import styles from './ChatPage.module.scss';

/**
 * Шапка чата: чей это разговор слева, пульт агентов и всё, чем прогон
 * управляется, — справа. Собственной шапки страницы (`PageHeader`) здесь нет,
 * поэтому ссылка на справку живёт в том же ряду, что и пульт.
 */
export function ChatHeader({
  chatTitle,
  projectName,
  projectPath,
  isProjectContext,
  chatId,
  activeRuns,
  totalCost,
  totalTokens,
  costUnit,
  onStopRun,
  onStopAllRuns,
  onViewRun,
  model,
  effort,
  defaultModel,
  defaultEffort,
  models,
  onModelChange,
  onEffortChange,
  isEditorPending,
  onOpenEditor,
  onOpenCode,
  onOpenTests,
  allowEdits,
  onAllowEditsChange,
  autoApprove,
  onAutoApproveChange,
  runStatus,
  onRetry,
  onContinue,
  onAllowAndContinue,
  tokens,
  costUsd,
  limitResetsAt,
  canExport,
  onExport,
  onRefresh,
}: ChatHeaderProps) {
  const { t } = useTranslation();

  return (
    <Stack
      direction="row"
      align="center"
      justify="between"
      gap="var(--spacing-sm)"
      wrap
      padding="var(--spacing-sm) var(--spacing-xl)"
      className={styles.header}
    >
      <Stack gap="var(--spacing-3xs)" className={styles.headerText}>
        <Typography variant="body" weight="medium" className={styles.title}>
          {chatTitle ?? projectName ?? t('chat.newChat')}
        </Typography>
        <Typography variant="caption" color="subtle" as="span" className={styles.title}>
          {projectPath ?? t('chat.sandboxHint')}
        </Typography>
      </Stack>

      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap justify="end">
        {/* Шапки PageHeader здесь нет — ссылку на справку ставим рядом с пультом. */}
        <Link
          to={HELP_ROUTE}
          search={{ topic: 'chat' }}
          className={styles.help}
          title={t('common.openHelp')}
          aria-label={t('common.openHelp')}
        >
          <Icon name="help" size={24} />
        </Link>

        <AgentsPanel
          activeRuns={activeRuns}
          totalCost={totalCost}
          totalTokens={totalTokens}
          costUnit={costUnit}
          onStop={onStopRun}
          onStopAll={onStopAllRuns}
          onView={onViewRun}
        />

        <ChatModelPicker
          model={model}
          effort={effort}
          defaultModel={defaultModel}
          defaultEffort={defaultEffort}
          models={models}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
        />

        {isProjectContext && projectPath && (
          <>
            {/* Код проекта прямо в панели: дерево файлов, дифф правок агента за
                этот разговор и правка на месте. Стоит перед «Открыть в
                редакторе» намеренно — это ответ на тот же вопрос («что он
                натворил»), только не требующий уходить из панели. */}
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="file" size={20} />}
              onClick={onOpenCode}
            >
              {t('projectCode.open')}
            </Button>

            {/* Тест-кейсы проекта: список того, что агент проверяет в
                интерфейсе, и пульт прогона. Рядом с кодом намеренно — это два
                ответа на один вопрос «в каком состоянии проект». */}
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="check" size={20} />}
              onClick={onOpenTests}
            >
              {t('projectTests.open')}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="scripts" size={20} />}
              isLoading={isEditorPending}
              onClick={() => onOpenEditor(projectPath)}
            >
              {t('projects.openInEditor')}
            </Button>
          </>
        )}

        {/* Запуск/остановка dev-сервера проекта + «Перейти» — в том же ряду,
            что и «Открыть в редакторе». */}
        {isProjectContext && projectPath && <ProjectRunnerControls path={projectPath} />}

        {/* Git проекта — тут же, но только если в каталоге есть .git:
            сам компонент вернёт null, когда репозитория нет. */}
        {isProjectContext && projectPath && <ProjectGitControls path={projectPath} />}

        {isProjectContext && (
          <Stack
            as="label"
            direction="row"
            align="center"
            gap="var(--spacing-2xs)"
            padding="var(--spacing-3xs) var(--spacing-xs)"
            className={styles.editsToggle}
          >
            <Toggle
              size="sm"
              checked={allowEdits}
              onCheckedChange={onAllowEditsChange}
              aria-label={t('chat.allowEdits')}
            />
            <Typography variant="caption" color={allowEdits ? 'default' : 'subtle'} as="span">
              {allowEdits ? t('chat.editsAllowed') : t('chat.readOnly')}
            </Typography>
          </Stack>
        )}

        {/* Автоподтверждение: панель сама разрешает безопасные запросы, а
            опасные (записи в git, удаление, миграции) и всё под правилами
            ask/deny из settings.json по-прежнему спрашивает. */}
        <Stack
          as="label"
          direction="row"
          align="center"
          gap="var(--spacing-2xs)"
          padding="var(--spacing-3xs) var(--spacing-xs)"
          className={styles.editsToggle}
          title={t('chat.autoApproveHint')}
        >
          <Toggle
            size="sm"
            checked={autoApprove}
            onCheckedChange={onAutoApproveChange}
            aria-label={t('chat.autoApprove')}
          />
          <Typography variant="caption" color={autoApprove ? 'default' : 'subtle'} as="span">
            {autoApprove ? t('chat.autoApproveOn') : t('chat.autoApproveOff')}
          </Typography>
        </Stack>

        {runStatus === 'error' && chatId && (
          <>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="refresh" size={18} />}
              onClick={onRetry}
              title={t('chat.retryHint')}
            >
              {t('chat.retry')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onContinue}
              title={t('chat.continueHint')}
            >
              {t('chat.continue')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onAllowAndContinue}
              title={t('chat.allowAndContinueHint')}
            >
              {t('chat.allowAndContinue')}
            </Button>
          </>
        )}
        {(tokens > 0 || costUsd !== undefined) && (
          <Badge tone="neutral">{formatSpend(costUnit, tokens, costUsd ?? 0)}</Badge>
        )}
        {limitResetsAt !== undefined && (
          <Badge tone="info">{t('chat.limitResets', { time: formatTime(limitResetsAt) })}</Badge>
        )}
        {canExport && (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Icon name="file" size={20} />}
            onClick={onExport}
            title={t('chat.exportHint')}
          >
            {t('chat.export')}
          </Button>
        )}
        <Button
          variant="ghost"
          iconOnly
          icon={<Icon name="refresh" size={24} />}
          aria-label={t('common.refresh')}
          onClick={onRefresh}
        />
      </Stack>
    </Stack>
  );
}
