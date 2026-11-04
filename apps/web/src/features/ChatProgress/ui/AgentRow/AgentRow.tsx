import { useTranslation } from 'react-i18next';
import type { MouseEvent } from 'react';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { Icon } from '@shared/ui/icon';
import { cn } from '@shared/lib/cn';
import { formatDuration } from '@shared/lib/format-duration';
import { formatTokens } from '@shared/lib/formatTokens';
import { agentTokenTotal, ExtensionChips, shortModel } from '@entities/AgentTree';
import type { AgentRowProps } from '../ChatProgressSheet.types';
import styles from './AgentRow.module.scss';
import { AGENT_TONE } from './AgentRow.constants';
import { agentView } from '../../model/agentView';
import { elapsedMs } from '../../model/elapsedMs';

/**
 * Субагент в «Кому раздана работа». В дереве — узел ARIA-дерева: модель,
 * вызовы, расход, время и последнее действие, щелчок открывает его ход справа,
 * у идущего — «Остановить». Вне дерева (старый сервер без id) — та же строка
 * без узла.
 */
export function AgentRow({ agent, isRunning, processAlive, now, tree, children }: AgentRowProps) {
  const { t } = useTranslation();
  const view = agentView(agent, isRunning, processAlive);
  const running = view === 'running';
  // «Писал N назад» — только у идущего: у законченного время ничего не говорит.
  const quiet = running ? elapsedMs(agent.lastActivityAt, now) : undefined;
  // Что субагент делает сейчас и сколько уже — живое ревью 18.10: строка
  // говорила «работает», пока полоса 26 минут ждала одну проверку.
  const total = running ? elapsedMs(agent.startedAt, now) : undefined;
  const ended = agent.endedAt ? Date.parse(agent.endedAt) : Number.NaN;
  const took = !running && Number.isFinite(ended) ? elapsedMs(agent.startedAt, ended) : undefined;
  const activity = running ? agent.activity : undefined;
  const activityFor = activity ? elapsedMs(activity.startedAt, now) : undefined;
  const what = activity ? [activity.name, activity.summary].filter(Boolean).join(': ') : '';
  const status = t(`chat.progress.agentStatus.${view}`);
  const tokens = agentTokenTotal(agent);
  const model = shortModel(agent.model);
  const metrics = [
    model,
    agent.toolCalls !== undefined
      ? t('agentTree.toolCalls', { count: agent.toolCalls })
      : undefined,
    tokens > 0 ? t('agentTree.tokens', { value: formatTokens(tokens) }) : undefined,
    took !== undefined ? t('agentTree.took', { for: formatDuration(took, t) }) : undefined,
  ].filter(Boolean);
  // Узлу без вложенных — пустое место под стрелку: узлы одного уровня в столбик.
  const toggle = (event: MouseEvent): void => {
    event.stopPropagation();
    tree?.onToggle();
  };

  return (
    <li
      className={cn(styles.agent, tree && styles.node, tree?.isSelected && styles.selected)}
      data-agent-view={view}
      {...(tree
        ? {
            role: 'treeitem',
            'aria-level': tree.level,
            'aria-selected': tree.isSelected,
            'aria-label': t('agentTree.nodeLabel', {
              kind: agent.kind,
              description: agent.description,
              status,
            }),
            ...(tree.expanded !== undefined ? { 'aria-expanded': tree.expanded } : {}),
            tabIndex: tree.isTabStop ? 0 : -1,
            'data-agent-node': agent.agentId ?? agent.id,
          }
        : {})}
    >
      <div
        className={cn(styles.head, tree?.onOpen && styles.openable)}
        {...(tree?.onOpen ? { onClick: tree.onOpen, title: t('agentTree.openHint') } : {})}
      >
        <span className={styles.lead}>
          {tree && tree.expanded !== undefined && (
            <button
              type="button"
              tabIndex={-1}
              className={styles.twisty}
              aria-label={agent.description}
              onClick={toggle}
            >
              <Icon name={tree.expanded ? 'chevronDown' : 'chevronRight'} size={14} />
            </button>
          )}
          {tree && tree.expanded === undefined && <span className={styles.twistySpace} />}
          <StatusDot tone={AGENT_TONE[view]} pulse={running} />
        </span>
        <span className={styles.headText}>
          <Typography variant="body-sm" as="span" weight="medium" className={styles.kind}>
            {agent.kind}
          </Typography>
          <Typography variant="caption" color="subtle" as="span" className={styles.agentText}>
            {agent.description}
          </Typography>
          <Typography variant="caption" color="subtle" as="span" className={styles.status}>
            {status}
            {agent.background && running && ` · ${t('chat.progress.agentBackground')}`}
            {total !== undefined &&
              ` · ${t('chat.progress.agentTotal', { for: formatDuration(total, t) })}`}
            {quiet !== undefined &&
              ` · ${t('chat.progress.agentQuiet', { ago: formatDuration(quiet, t) })}`}
          </Typography>
        </span>
      </div>

      {metrics.length > 0 && (
        <Typography
          variant="caption"
          color="subtle"
          as="div"
          className={styles.metrics}
          {...(agent.tokens
            ? {
                title: t('agentTree.tokensHint', {
                  input: formatTokens(agent.tokens.input),
                  cacheRead: formatTokens(agent.tokens.cacheRead),
                  cacheCreation: formatTokens(agent.tokens.cacheCreation),
                  output: formatTokens(agent.tokens.output),
                }),
              }
            : {})}
          data-agent-metrics
        >
          {metrics.join(' · ')}
        </Typography>
      )}

      <ExtensionChips
        summary={agent.extensions}
        className={styles.extensions}
        openLabel={t('agentTree.extensions.openAgent', { description: agent.description })}
        {...(tree?.onExtensions ? { onOpen: tree.onExtensions } : {})}
      />

      {activity && (
        <Stack
          direction="row"
          align="center"
          gap="var(--spacing-2xs)"
          className={styles.activity}
          data-agent-activity={activity.waiting ? 'waiting' : 'working'}
        >
          {activity.waiting && (
            <span className={styles.waiting}>{t('chat.progress.agentWaiting')}</span>
          )}
          <Typography variant="caption" color="subtle" as="span" className={styles.activityText}>
            {activityFor !== undefined
              ? t('chat.progress.agentNow', { what, for: formatDuration(activityFor, t) })
              : what}
          </Typography>
        </Stack>
      )}

      {!activity && agent.lastAction && (
        <Typography
          variant="caption"
          color="subtle"
          as="div"
          className={cn(styles.activity, styles.activityText)}
          data-agent-last
        >
          {t('agentTree.last', { what: agent.lastAction })}
        </Typography>
      )}

      {agent.result && (
        <details className={styles.result}>
          <summary>{t('chat.progress.result')}</summary>
          <div className={styles.resultBody}>{agent.result}</div>
        </details>
      )}

      {children}
    </li>
  );
}
