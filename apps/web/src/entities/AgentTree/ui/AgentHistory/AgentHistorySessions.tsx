import { useTranslation } from 'react-i18next';
import { MAIN_AGENT_ID, type AgentHistorySession } from '@agentdeck/contracts/agent-history';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { cn } from '@shared/lib/cn';
import { formatDateTime } from '@shared/lib/formatDateTime';
import { formatDuration } from '@shared/lib/format-duration';
import { formatTokens } from '@shared/lib/formatTokens';
import { agentTokenTotal, shortModel } from '../../model/agentTree';
import {
  anomalyParts,
  historyAgentState,
  repeatedReadsHint,
  mainTokenTotal,
  sessionNumber,
  sessionSpanMs,
} from '../../model/agentHistory';
import { STATE_TONE } from './AgentHistory.constants';
import type { AgentHistorySessionsProps } from './AgentHistory.types';
import styles from './AgentHistory.module.scss';

const parts = (items: Array<string | undefined>): string => items.filter(Boolean).join(' · ');

/**
 * Левая колонка окна «История агентов»: сессии новыми первыми, номер — от
 * первой; у каждой стадия звена, время, главный агент одной строкой и её
 * субагенты (тип, модель, вызовы, расход, начало итога). Своим файлом — чтобы
 * тест рисовал её без окна.
 */
export function AgentHistorySessions({
  history,
  isLoading,
  isRunning,
  picked,
  onPick,
}: AgentHistorySessionsProps) {
  const { t, i18n } = useTranslation();
  const sessions = history?.sessions ?? [];
  const mainPicked = (session: AgentHistorySession): boolean =>
    picked?.chatId === session.chatId && picked.agentId === MAIN_AGENT_ID;

  const sessionLine = (session: AgentHistorySession): string => {
    const span = sessionSpanMs(session);
    return parts([
      session.startedAt ? formatDateTime(session.startedAt, i18n.language) : undefined,
      span !== undefined ? formatDuration(span, t) : undefined,
    ]);
  };

  const mainLine = (session: AgentHistorySession): string => {
    const tokens = mainTokenTotal(session);
    return parts([
      t('agentTree.toolCalls', { count: session.main.toolCalls }),
      tokens > 0 ? t('agentTree.tokens', { value: formatTokens(tokens) }) : undefined,
      shortModel(session.main.model),
    ]);
  };

  /** Странности агента строкой под его строкой; нет — ничего. */
  const anomalyLine = (anomalies: Parameters<typeof anomalyParts>[0]) => {
    const list = anomalyParts(anomalies, t);
    if (list.length === 0) return null;
    return (
      <Typography
        variant="caption"
        as="span"
        className={styles.anomalies}
        title={repeatedReadsHint(anomalies, t)}
        data-agent-history-anomalies
      >
        {list.join(' · ')}
      </Typography>
    );
  };

  return (
    <nav className={styles.sessions} aria-label={t('agentTree.history.sessions')}>
      {isLoading && !history && (
        <Typography variant="body-sm" color="subtle" as="p">
          {t('agentTree.history.loading')}
        </Typography>
      )}
      {history && sessions.length === 0 && (
        <Typography variant="body-sm" color="subtle" as="p">
          {t('agentTree.history.empty')}
        </Typography>
      )}
      <ol className={styles.sessionList}>
        {sessions.map((session, index) => (
          <li
            key={session.chatId}
            className={styles.session}
            data-agent-history-session={session.chatId}
          >
            <div className={styles.sessionHead}>
              <Typography variant="body-sm" weight="medium" as="span">
                {t('agentTree.history.session', {
                  n: history ? sessionNumber(history, index) : index + 1,
                })}
                {session.stage &&
                  ` · ${t(`agentTree.history.stage.${session.stage}`, {
                    defaultValue: session.stage,
                  })}`}
              </Typography>
              {session.current && (
                <span className={styles.current}>{t('agentTree.history.current')}</span>
              )}
            </div>
            <Typography variant="caption" color="subtle" as="span">
              {sessionLine(session)}
            </Typography>
            <button
              type="button"
              className={cn(
                styles.agent,
                styles.mainButton,
                mainPicked(session) && styles.agentSelected,
              )}
              aria-pressed={mainPicked(session)}
              title={t('agentTree.history.mainOpen')}
              data-agent-history-main={session.chatId}
              onClick={() => onPick({ chatId: session.chatId, agentId: MAIN_AGENT_ID })}
            >
              <Typography variant="caption" as="span" className={styles.main}>
                {t('agentTree.history.main')}: {mainLine(session)}
              </Typography>
              {anomalyLine(session.main.anomalies)}
            </button>
            {session.agents.length === 0 ? (
              <Typography variant="caption" color="subtle" as="span">
                {t('agentTree.history.noAgents')}
              </Typography>
            ) : (
              <ul className={styles.agentList}>
                {session.agents.map((agent) => {
                  const state = historyAgentState(agent, session, isRunning);
                  const tokens = agentTokenTotal(agent);
                  const selected =
                    picked?.chatId === session.chatId && picked.agentId === agent.agentId;
                  const meta = parts([
                    agent.kind,
                    shortModel(agent.model),
                    agent.toolCalls !== undefined
                      ? t('agentTree.toolCalls', { count: agent.toolCalls })
                      : undefined,
                    tokens > 0 ? t('agentTree.tokens', { value: formatTokens(tokens) }) : undefined,
                  ]);
                  return (
                    <li key={agent.id} className={agent.parentId ? styles.nested : undefined}>
                      <button
                        type="button"
                        className={cn(styles.agent, selected && styles.agentSelected)}
                        aria-pressed={selected}
                        disabled={!agent.agentId}
                        data-agent-history-agent={agent.agentId ?? agent.id}
                        data-agent-state={state}
                        onClick={() =>
                          agent.agentId &&
                          onPick({ chatId: session.chatId, agentId: agent.agentId })
                        }
                      >
                        <span className={styles.agentHead}>
                          <StatusDot
                            tone={STATE_TONE[state]}
                            label={t(`agentTree.history.state.${state}`)}
                          />
                          <Typography variant="body-sm" as="span" className={styles.agentName}>
                            {agent.description}
                          </Typography>
                        </span>
                        <Typography variant="caption" color="subtle" as="span">
                          {meta}
                        </Typography>
                        {agent.agentId && anomalyLine(session.anomalies?.[agent.agentId])}
                        {agent.result && (
                          <Typography
                            variant="caption"
                            color="subtle"
                            as="span"
                            className={styles.result}
                          >
                            {agent.result}
                          </Typography>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
