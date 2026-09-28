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
import { DeliveryControl } from '@features/ProjectGit';
import { ChatHeaderMenu } from './ChatHeaderMenu';
import { useLineStarts } from './model/useLineStarts';
import { formatTime } from './lib/formatTime';
import type { ChatHeaderProps } from './ChatHeader.types';
import styles from './ChatPage.module.scss';

/**
 * Шапка чата — два ряда по смыслу, а не как получилось переносом.
 *
 * Верхний — РАЗГОВОР: чей он (название, путь) и чем этот разговор идёт
 * (модель и глубина, пульт агентов с расходом, «Настройки чата»). Нижний —
 * ПРОЕКТ, только у вкладки проекта: доставка до MR, код/тесты/редактор и
 * dev-сервер. Внутри ряда группы разделены чертой (у группы, открывающей
 * перенесённую строку, черты нет — `useLineStarts`); группа переносится
 * целиком, её кнопки не разъезжаются по строкам. Все элементы — одной высоты
 * (34px) и одного кегля: раньше в ряду стояли мелкие select'ы, обведённая
 * «До MR» и голые шестерёнки — пять калибров в одной строке (владелец, 28.09).
 *
 * Собственной шапки страницы (`PageHeader`) здесь нет, поэтому ссылка на
 * справку живёт в меню «Настройки чата».
 */
export function ChatHeader({
  chatTitle,
  projectName,
  projectPath,
  isProjectContext,
  groupDeliver,
  chatId,
  sessionId,
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
  errorOverflow,
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
  const { t, i18n } = useTranslation();
  const chatBarRef = useLineStarts<HTMLDivElement>();
  const projectBarRef = useLineStarts<HTMLDivElement>();

  const showRetry = runStatus === 'error' && Boolean(chatId) && !errorOverflow;
  const showSpend = tokens > 0 || costUsd !== undefined;

  return (
    <div className={styles.header}>
      <div className={styles.headRow}>
        <Stack gap="var(--spacing-3xs)" className={styles.headerText}>
          <Typography variant="body" weight="medium" className={styles.title}>
            {chatTitle ?? projectName ?? t('chat.newChat')}
          </Typography>
          <Typography variant="caption" color="subtle" as="span" className={styles.title}>
            {projectPath ?? t('chat.sandboxHint')}
          </Typography>
        </Stack>

        <div ref={chatBarRef} className={styles.bar} role="group" aria-label={t('chat.barChat')}>
          {/* Упавший прогон: что с ним делать — первым, у края заголовка. */}
          {showRetry && (
            <div className={styles.group}>
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
            </div>
          )}

          {/* Подписи контура встают узкой колонкой под select'ами — группа
              выше соседних, поэтому ряд выровнен по верху, а не по центру. */}
          <div className={styles.group}>
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
          </div>

          <div className={styles.group}>
            <AgentsPanel
              activeRuns={activeRuns}
              totalCost={totalCost}
              totalTokens={totalTokens}
              costUnit={costUnit}
              onStop={onStopRun}
              onStopAll={onStopAllRuns}
              onView={onViewRun}
            />
            {showSpend && (
              <Badge tone="neutral">{formatSpend(costUnit, tokens, costUsd ?? 0)}</Badge>
            )}
            {limitResetsAt !== undefined && (
              <Badge tone="info">
                {t('chat.limitResets', { time: formatTime(limitResetsAt, i18n.language) })}
              </Badge>
            )}
          </div>

          {/* Тумблеры прав, выгрузка, обновление и справка — за одной кнопкой у
              самого края: трогают их редко, а ряд шапки они забивали целиком. */}
          <div className={styles.group}>
            <ChatHeaderMenu
              {...(chatId ? { chatId } : {})}
              {...(sessionId ? { sessionId } : {})}
              {...(isProjectContext ? { allowEdits, onAllowEditsChange, projectPath } : {})}
              autoApprove={autoApprove}
              onAutoApproveChange={onAutoApproveChange}
              canExport={canExport}
              onExport={onExport}
              onRefresh={onRefresh}
              {...(onRestartSession ? { onRestartSession } : {})}
              {...(runStatus === 'running'
                ? { restartBlocked: t('chat.handoff.restartRunning') }
                : {})}
            />
          </div>
        </div>
      </div>

      {isProjectContext && projectPath && (
        <div
          ref={projectBarRef}
          className={styles.bar}
          role="group"
          aria-label={t('chat.barProject')}
        >
          {/* Доставка до MR — первой: её подпись говорит, чем кончится
              следующая задача, и искать её по меню нельзя. */}
          <div className={styles.group}>
            <DeliveryControl
              path={projectPath}
              {...(groupDeliver === undefined ? {} : { groupDeliver })}
            />
          </div>

          {/* Код, тесты, редактор — три ответа на один вопрос «в каком
              состоянии проект»: код и дифф правок агента прямо в панели,
              тест-кейсы с пультом прогона и уже потом — уйти в редактор. */}
          <div className={styles.group}>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="file" size={20} />}
              onClick={onOpenCode}
              title={t('projectCode.open')}
            >
              <span data-bar-label="">{t('projectCode.open')}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="check" size={20} />}
              onClick={onOpenTests}
              title={t('projectTests.open')}
            >
              <span data-bar-label="">{t('projectTests.open')}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="scripts" size={20} />}
              isLoading={isEditorPending}
              onClick={() => onOpenEditor(projectPath)}
              title={t('projects.openInEditor')}
            >
              <span data-bar-label="">{t('chat.barEditor')}</span>
            </Button>
          </div>

          {/* Dev-сервер: подписанная кнопка настроек, запуск, ссылка «Перейти». */}
          <div className={styles.group}>
            <ProjectRunnerControls path={projectPath} />
          </div>
        </div>
      )}
    </div>
  );
}
