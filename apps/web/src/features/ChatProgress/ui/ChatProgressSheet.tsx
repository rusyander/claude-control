import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Badge } from '@shared/ui/badge';
import { summarizeProgress } from '../model/progressView';
import { TaskRow } from './TaskRow';
import { AgentRow } from './AgentRow';
import type { ChatProgressSheetProps } from './ChatProgressSheet.types';
import styles from './ChatProgressSheet.module.scss';

/**
 * Панель прогресса: что агент наметил себе сам и что из этого уже сделано.
 *
 * Только чтение — и это не ограничение, а суть. План ведёт агент (вызовами
 * TodoWrite), панель показывает его след из транскрипта. Можно было бы дать
 * галочки, но тогда галочка в панели и состояние у агента разошлись бы в первый
 * же ход, и панель начала бы врать.
 *
 * Когда агент раздаёт работу субагентам, их видно тут же веткой ниже: кто
 * запущен, с какой задачей, чем кончил. Иначе про оркестрацию известно только
 * то, что «что-то идёт».
 */
export function ChatProgressSheet({ progress, isRunning }: ChatProgressSheetProps) {
  const { t } = useTranslation();
  const [isOpen, setOpen] = useState(false);
  const summary = summarizeProgress(progress);

  if (!summary.hasAnything) return null;

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

        <Badge tone={summary.done === summary.total ? 'success' : 'info'}>
          {t('chat.progress.count', { done: summary.done, total: summary.total })}
        </Badge>

        {summary.agentsTotal > 0 && (
          <Badge tone={summary.agentsRunning > 0 ? 'warning' : 'neutral'}>
            {t('chat.progress.agents', { count: summary.agentsTotal })}
          </Badge>
        )}

        {/* Текущий шаг — прямо в свёрнутой полосе: чаще всего нужен именно он,
            и ради одной строки открывать панель незачем. */}
        <Typography variant="caption" color="subtle" as="span" className={styles.current}>
          {summary.current ?? (isRunning ? t('chat.progress.working') : '')}
        </Typography>
      </button>

      {isOpen && (
        <div className={styles.body}>
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

          {progress && progress.agents.length > 0 && (
            <Stack gap="var(--spacing-2xs)" marginTop="var(--spacing-sm)">
              <Typography variant="caption" color="subtle" as="span">
                {t('chat.progress.tree')}
              </Typography>
              <ul className={styles.tree}>
                {progress.agents.map((agent) => (
                  <AgentRow key={agent.id} agent={agent} />
                ))}
              </ul>
            </Stack>
          )}
        </div>
      )}
    </div>
  );
}
