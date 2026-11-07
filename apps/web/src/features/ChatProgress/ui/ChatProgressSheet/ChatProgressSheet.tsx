import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatProgress, ProgressAgent } from '@agentdeck/contracts';
import { NO_FILTERS, useCoreAgents, withCoreFacts } from '@entities/AgentTree';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { formatDuration } from '@shared/lib/format-duration';
import { useNow } from '../../model/useNow';
import { TaskRow } from '../TaskRow/TaskRow';
import { AgentTree } from '../AgentTree/AgentTree';
import { ShellRow } from '../ShellRow/ShellRow';
import type { ChatProgressSheetProps } from '../ChatProgressSheet.types';
import styles from './ChatProgressSheet.module.scss';
import { elapsedMs } from '../../model/elapsedMs';
import { summarizeProgress } from '../../model/summarizeProgress';
import { clockTicks } from '../../model/clockTicks';

/** Прогресса из транскрипта нет (чат чужого CLI) — пустой план, субагентов даст ядро. */
const NO_PROGRESS: ChatProgress = { tasks: [], agents: [] };
/** Одна пустая ссылка: новый массив на каждом рендере пересчитывал бы дерево. */
const NO_AGENTS: ProgressAgent[] = [];

/**
 * Панель прогресса: что агент наметил себе сам и что из этого уже сделано.
 *
 * Только чтение — и это не ограничение, а суть. План ведёт агент (вызовами
 * TodoWrite), панель показывает его след из транскрипта. Можно было бы дать
 * галочки, но тогда галочка в панели и состояние у агента разошлись бы в первый
 * же ход, и панель начала бы врать.
 *
 * Когда агент раздаёт работу субагентам, их видно тут же деревом ниже: кто
 * запущен, кем, с какой задачей, на какой модели, сколько вызовов и токенов,
 * чем кончил. Узел открывает ход субагента справа, идущего можно остановить.
 * Иначе про оркестрацию известно только то, что «что-то идёт».
 *
 * Ниже плана — что идёт прямо сейчас и что увели в фон, с таймером. Двадцать
 * минут тишины без этой строки не отличить от зависания, а фоновая команда,
 * умершая вместе с процессом разговора, выглядела бы идущей.
 */
export function ChatProgressSheet({
  chatId,
  progress,
  isRunning = false,
  awaiting = false,
}: ChatProgressSheetProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);
  // Субагенты — строки транскрипта с фактами ядра. У чата чужого CLI строк транскрипта нет вовсе,
  // и без ядра полоса не вставала, хотя субагент шёл (F-07). Запрос — тот же, что у дерева ниже и
  // у кнопки «Агенты»: один кэш, второго опроса нет.
  const coreNodes = useCoreAgents(chatId, NO_FILTERS, isRunning).data?.nodes;
  const transcriptAgents = progress?.agents;
  const agents = useMemo(
    () => withCoreFacts(transcriptAgents ?? [], coreNodes ?? []),
    [transcriptAgents, coreNodes],
  );
  const summary = summarizeProgress({ ...(progress ?? NO_PROGRESS), agents }, isRunning);
  const now = useNow(clockTicks(summary, isRunning));
  const waiting = awaiting && !isRunning;

  if (!summary.hasAnything && !waiting) return null;

  const active = summary.activeTool;
  const activeElapsed = active ? elapsedMs(active.startedAt, now) : undefined;
  const activeLine = active
    ? [active.name, active.summary, activeElapsed !== undefined && formatDuration(activeElapsed, t)]
        .filter(Boolean)
        .join(' · ')
    : undefined;
  const shells = progress?.shells ?? [];
  /** Ни шага, ни вызова: ход идёт сам по себе или работают только фоновые агенты. */
  const quietLine = (): string => {
    if (isRunning) return t('chat.progress.working');
    if (summary.agentsRunning > 0)
      return t('chat.progress.backgroundAgents', { count: summary.agentsRunning });
    return '';
  };

  return (
    <div className={styles.sheet} data-chat-progress>
      <button
        type="button"
        className={styles.head}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={isOpen}
      >
        <Icon name={isOpen ? 'chevronDown' : 'chevronUp'} size={18} />

        <Typography variant="body-sm" weight="medium" as="span">
          {t('chat.progress.title')}
        </Typography>

        {/* Ждёт ответа — первым: это единственное состояние, после которого
            работа не пойдёт сама, и оно не должно тонуть за счётчиками. */}
        {waiting && (
          <Badge tone="warning" data-progress-awaiting>
            {t('chat.progress.awaiting')}
          </Badge>
        )}

        {summary.total > 0 && (
          <Badge tone={summary.done === summary.total ? 'success' : 'info'}>
            {t('chat.progress.count', { done: summary.done, total: summary.total })}
          </Badge>
        )}

        {summary.agentsTotal > 0 && (
          <Badge tone={summary.agentsRunning > 0 ? 'warning' : 'neutral'}>
            {t('chat.progress.agents', { count: summary.agentsTotal })}
          </Badge>
        )}

        {summary.agentsLost > 0 && (
          <Badge tone="danger" data-progress-agents-lost>
            {t('chat.progress.agentsLost', { count: summary.agentsLost })}
          </Badge>
        )}

        {summary.shellsRunning > 0 && (
          <Badge tone="warning">
            {t('chat.progress.shellsRunning', { count: summary.shellsRunning })}
          </Badge>
        )}

        {summary.shellsLost > 0 && (
          <Badge tone="danger">
            {t('chat.progress.shellsLost', { count: summary.shellsLost })}
          </Badge>
        )}

        {/* Текущий шаг — прямо в свёрнутой полосе: чаще всего нужен именно он,
            и ради одной строки открывать панель незачем. Нет шага в плане —
            показываем вызов, который идёт, с таймером. */}
        <Typography variant="caption" color="subtle" as="span" className={styles.current}>
          {summary.current ?? activeLine ?? quietLine()}
        </Typography>
      </button>

      {isOpen && (
        <div className={styles.body}>
          {activeLine && (
            <Typography variant="body-sm" as="p" className={styles.now}>
              {t('chat.progress.now', { what: activeLine })}
            </Typography>
          )}

          {progress?.tasks.length ? (
            <ul className={styles.tasks}>
              {progress.tasks.map((task, index) => (
                <TaskRow key={`${index}-${task.text}`} task={task} />
              ))}
            </ul>
          ) : (
            <Typography variant="body-sm" color="subtle">
              {t('chat.progress.noTasks')}
            </Typography>
          )}

          {agents.length > 0 && (
            <Stack gap="var(--spacing-2xs)" marginTop="var(--spacing-sm)">
              <Typography variant="caption" color="subtle" as="span">
                {t('chat.progress.tree')}
              </Typography>
              <AgentTree
                {...(chatId ? { chatId } : {})}
                agents={transcriptAgents ?? NO_AGENTS}
                isRunning={isRunning}
                {...(progress?.processAlive !== undefined
                  ? { processAlive: progress.processAlive }
                  : {})}
                now={now}
              />
              {summary.agentsLost > 0 && (
                <Typography variant="caption" color="subtle" as="p" data-agents-lost-hint>
                  {t('chat.progress.agentsLostHint')}
                </Typography>
              )}
            </Stack>
          )}

          {shells.length > 0 && (
            <Stack gap="var(--spacing-2xs)" marginTop="var(--spacing-sm)">
              <Typography variant="caption" color="subtle" as="span">
                {t('chat.progress.shells')}
              </Typography>
              <ul className={styles.tree}>
                {shells.map((shell) => (
                  <ShellRow
                    key={shell.id}
                    shell={shell}
                    isRunning={isRunning}
                    {...(progress?.processAlive !== undefined
                      ? { processAlive: progress.processAlive }
                      : {})}
                    now={now}
                  />
                ))}
              </ul>
              {summary.shellsLost > 0 && (
                <Typography variant="caption" color="subtle" as="p">
                  {t('chat.progress.shellsLostHint')}
                </Typography>
              )}
            </Stack>
          )}
        </div>
      )}
    </div>
  );
}
