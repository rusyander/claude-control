import { useTranslation } from 'react-i18next';
import { MAIN_AGENT_ID, type AgentHistorySession } from '@agentdeck/contracts/agent-history';
import type { ProgressActiveTool } from '@agentdeck/contracts';
import { Typography } from '@shared/ui/typography';
import { StatusDot } from '@shared/ui/status-dot';
import { cn } from '@shared/lib/cn';
import { useNow } from '@shared/lib/use-now';
import { formatClock } from '@shared/lib/format-clock';
import { formatDateTime } from '@shared/lib/formatDateTime';
import { formatDuration } from '@shared/lib/format-duration';
import { elapsedSince, liveNow, sessionNumber } from '../../model/agentHistory';
import type { AgentHistoryNowProps } from './AgentHistory.types';
import styles from './AgentHistory.module.scss';

/**
 * «Сейчас» вверху окна истории: работает ли главный агент и чем занят (вызов,
 * с какого времени, сколько идёт), какие субагенты работают и что делает
 * каждый, — или прямо «субагентов сейчас нет». Источник — отметки сессий от
 * сервера (`liveMain`, `liveAgents`), из них же сложены числа у кнопки: окно не
 * может звать живым того, кого строка «сейчас: …» не считает. Строка — кнопка:
 * ход открывается справа.
 */
export function AgentHistoryNow({ history, picked, onPick }: AgentHistoryNowProps) {
  const { t, i18n } = useTranslation();
  const now = liveNow(history);
  const anyLive = now.mains.length + now.agents.length > 0;
  const clock = useNow(anyLive);

  const sessionName = (session: AgentHistorySession, index: number): string => {
    const name = t('agentTree.history.session', { n: sessionNumber(history, index) });
    if (!session.stage) return name;
    const stage = t(`agentTree.history.stage.${session.stage}`, { defaultValue: session.stage });
    return `${name} · ${stage}`;
  };

  /** Вызов строкой: что, с какого времени, сколько идёт. */
  const toolLine = (tool: ProgressActiveTool) => {
    const what = [tool.name, tool.summary].filter(Boolean).join(': ');
    const running = elapsedSince(tool.startedAt, clock);
    const when = [
      tool.startedAt
        ? t('agentTree.history.now.since', { clock: formatClock(tool.startedAt, i18n.language) })
        : undefined,
      running !== undefined
        ? t('agentTree.history.now.runningFor', { for: formatDuration(running, t) })
        : undefined,
    ].filter(Boolean);
    return (
      <Typography variant="caption" as="span" className={styles.nowDoing} data-now-tool>
        {tool.waiting && (
          <span className={styles.nowWaiting}>{t('agentTree.history.now.waiting')}</span>
        )}
        {tool.waiting ? ' ' : ''}
        {what}
        {when.length > 0 && (
          <Typography variant="caption" color="subtle" as="span">
            {` · ${when.join(' · ')}`}
          </Typography>
        )}
      </Typography>
    );
  };

  const last = (what: string | undefined): string | undefined =>
    what ? t('agentTree.last', { what }) : undefined;

  /** Подпись из непустых частей; пусто — ничего. */
  const captionLine = (items: Array<string | undefined>) => {
    const text = items.filter(Boolean);
    if (text.length === 0) return null;
    return (
      <Typography variant="caption" color="subtle" as="span" className={styles.nowDoing}>
        {text.join(' · ')}
      </Typography>
    );
  };

  /** Чем занят главный: живой — открытый вызов или «пишет ответ», молчащий — где встал. */
  const mainDoing = (session: AgentHistorySession, live: boolean) => {
    if (live && session.main.openTool) return toolLine(session.main.openTool);
    if (live) {
      return captionLine([t('agentTree.history.now.answering'), last(session.main.lastAction)]);
    }
    return captionLine([
      last(session.main.lastAction),
      session.endedAt
        ? t('agentTree.history.now.lastWrite', {
            when: formatDateTime(session.endedAt, i18n.language),
          })
        : undefined,
    ]);
  };

  const isPicked = (chatId: string, agentId: string): boolean =>
    picked?.chatId === chatId && picked.agentId === agentId;

  const mainRow = (session: AgentHistorySession, index: number, live: boolean) => (
    <li key={`main-${session.chatId}`}>
      <button
        type="button"
        className={cn(
          styles.agent,
          isPicked(session.chatId, MAIN_AGENT_ID) && styles.agentSelected,
        )}
        aria-pressed={isPicked(session.chatId, MAIN_AGENT_ID)}
        title={t('agentTree.history.now.openHint')}
        data-now-main={live ? 'live' : 'idle'}
        onClick={() => onPick({ chatId: session.chatId, agentId: MAIN_AGENT_ID })}
      >
        <span className={styles.agentHead}>
          <StatusDot tone={live ? 'warning' : 'neutral'} pulse={live} />
          <Typography variant="body-sm" as="span" className={styles.agentName}>
            {t('agentTree.history.now.main')}{' '}
            <span className={cn(styles.nowState, live && styles.nowStateLive)}>
              {live ? t('agentTree.history.now.mainLive') : t('agentTree.history.now.mainIdle')}
            </span>
          </Typography>
        </span>
        <Typography variant="caption" color="subtle" as="span">
          {sessionName(session, index)}
        </Typography>
        {mainDoing(session, live)}
      </button>
    </li>
  );

  return (
    <section
      className={cn(styles.now, anyLive && styles.nowLive)}
      aria-label={t('agentTree.history.now.title')}
      title={t('agentTree.history.liveHint')}
      data-agent-history-now={`${now.mains.length}:${now.agents.length}`}
    >
      <Typography variant="body-sm" weight="medium" as="h3">
        {t('agentTree.history.now.title')}
      </Typography>
      <ul className={styles.nowGroup}>
        {now.mains.map(({ session, index }) => mainRow(session, index, true))}
        {now.idle && mainRow(now.idle.session, now.idle.index, false)}
      </ul>
      <Typography variant="caption" weight="medium" as="span">
        {t('agentTree.history.now.subagents')}
      </Typography>
      {now.agents.length === 0 ? (
        <Typography variant="caption" color="subtle" as="span" data-now-no-subagents>
          {t('agentTree.history.now.noSubagents')}
        </Typography>
      ) : (
        <ul className={styles.nowGroup}>
          {now.agents.map(({ session, index, agent }) => (
            <li key={`${session.chatId}-${agent.id}`}>
              <button
                type="button"
                className={cn(
                  styles.agent,
                  agent.agentId && isPicked(session.chatId, agent.agentId) && styles.agentSelected,
                )}
                aria-pressed={Boolean(agent.agentId && isPicked(session.chatId, agent.agentId))}
                disabled={!agent.agentId}
                title={t('agentTree.history.now.openHint')}
                data-now-agent={agent.agentId ?? agent.id}
                onClick={() =>
                  agent.agentId && onPick({ chatId: session.chatId, agentId: agent.agentId })
                }
              >
                <span className={styles.agentHead}>
                  <StatusDot tone="warning" pulse label={t('agentTree.history.state.running')} />
                  <Typography variant="body-sm" as="span" className={styles.agentName}>
                    {agent.description}
                  </Typography>
                </span>
                <Typography variant="caption" color="subtle" as="span">
                  {[agent.kind, sessionName(session, index)].join(' · ')}
                </Typography>
                {agent.activity ? toolLine(agent.activity) : captionLine([last(agent.lastAction)])}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
