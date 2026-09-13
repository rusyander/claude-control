import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { formatSpend } from '@shared/lib/format';
import { AgentsPanel } from '@features/AgentsPanel';
import { ChatModelPicker } from '@features/ChatModelPicker';
import { ProjectRunnerControls } from '@features/ProjectRunner';
import { ChatHeaderMenu } from './ChatHeaderMenu';
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
  consumer,
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
  onRestartSession,
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

      {/* По верху: выбор модели с подписями контура выше кнопок, и по центру
          «Агенты» и «Настройки» висели бы посреди подписей. */}
      <Stack direction="row" align="start" gap="var(--spacing-xs)" wrap justify="end">
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
          consumer={consumer}
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

        {/* Тумблеры прав, выгрузка, обновление и справка — за одной кнопкой у
            самого края: трогают их редко, а ряд шапки они забивали целиком. */}
        <ChatHeaderMenu
          {...(isProjectContext ? { allowEdits, onAllowEditsChange, projectPath } : {})}
          autoApprove={autoApprove}
          onAutoApproveChange={onAutoApproveChange}
          canExport={canExport}
          onExport={onExport}
          onRefresh={onRefresh}
          {...(onRestartSession ? { onRestartSession } : {})}
          {...(runStatus === 'running' ? { restartBlocked: t('chat.handoff.restartRunning') } : {})}
        />
      </Stack>
    </Stack>
  );
}
