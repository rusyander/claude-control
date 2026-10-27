import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatProgress } from '@entities/Chat';
import {
  AgentExtensionsModal,
  AgentHistoryButton,
  agentCounts,
  agentState,
  ExtensionChips,
  hasHistory,
  mergeSummaries,
  openAgentPane,
  useAgentHistory,
  type AgentState,
} from '@entities/AgentTree';
import { StatusDot } from '@shared/ui/status-dot';
import { Typography } from '@shared/ui/typography';
import { HUB_POLL_MS } from '../GroupStepLine/GroupStepLine.constants';
import type { GroupAgentsProps } from './GroupAgents.types';
import styles from './GroupAgents.module.scss';

/** Сколько переходов показывать в карточке: дальше — «ещё N». */
const SHOWN = 6;

const TONE: Record<AgentState, 'danger' | 'success' | 'warning' | 'neutral'> = {
  running: 'warning',
  done: 'success',
  failed: 'danger',
  lost: 'danger',
  stopped: 'neutral',
};

/**
 * Агенты группы в её карточке хаба: сколько субагентов идёт и сколько
 * закончило, и переход к каждому — чат группы открывается сразу с ходом этого
 * субагента справа. Идущие — первыми: за ними и заходят. Ниже — скиллы, хуки и
 * MCP всей группы (главный агент и субагенты вместе); щелчок открывает окно с
 * хронологией каждого. Прогресс — тот же запрос, что у индикатора группы
 * (`GroupProgress`), второго опроса нет. Кнопка «История агентов» — всегда,
 * когда у чата есть хоть одна сессия: строка выше знает только текущую сессию,
 * а группа живёт многими (после паузы — новый разговор, ревью и правки — свои
 * чаты), и субагенты прошлых сессий иначе не видны нигде.
 */
export function GroupAgents({ chatId, group, onOpen }: GroupAgentsProps) {
  const { t } = useTranslation();
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const { data } = useChatProgress(chatId, group.isRunning, HUB_POLL_MS);
  const agents = data?.agents ?? [];
  const extensions = mergeSummaries([data?.extensions, ...agents.map((agent) => agent.extensions)]);
  const history = useAgentHistory(chatId, group.isRunning);
  if (agents.length === 0 && extensions.length === 0 && !hasHistory(history.data)) return null;
  const counts = agentCounts(agents, group.isRunning, data?.processAlive);
  const jumpable = agents
    .filter((agent) => agent.agentId)
    .map((agent) => ({ agent, state: agentState(agent, group.isRunning, data?.processAlive) }))
    .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running'));
  const shown = jumpable.slice(0, SHOWN);
  const more = jumpable.length - shown.length;

  return (
    <div className={styles.root} data-group-agents={counts.total}>
      {agents.length > 0 && (
        <Typography variant="caption" color="subtle" as="span" className={styles.counts}>
          {t('agentTree.group.title')}:{' '}
          {t('agentTree.group.counts', { running: counts.running, finished: counts.finished })}
        </Typography>
      )}
      {shown.length > 0 && (
        <ul className={styles.list}>
          {shown.map(({ agent, state }) => (
            <li key={agent.id}>
              <button
                type="button"
                className={styles.jump}
                title={t('agentTree.group.jumpHint', { description: agent.description })}
                data-group-agent-jump={agent.agentId}
                data-agent-state={state}
                onClick={() => {
                  if (!agent.agentId) return;
                  openAgentPane(chatId, agent.agentId);
                  onOpen(chatId);
                }}
              >
                <StatusDot tone={TONE[state]} pulse={state === 'running'} />
                <span className={styles.jumpText}>{agent.description}</span>
              </button>
            </li>
          ))}
          {more > 0 && (
            <li>
              <Typography variant="caption" color="subtle" as="span">
                {t('agentTree.group.more', { count: more })}
              </Typography>
            </li>
          )}
        </ul>
      )}
      <AgentHistoryButton chatId={chatId} isRunning={group.isRunning} />
      {extensions.length > 0 && (
        <span className={styles.extensions} data-group-extensions>
          <ExtensionChips summary={extensions} onOpen={() => setExtensionsOpen(true)} />
        </span>
      )}
      {data && (
        <AgentExtensionsModal
          chatId={chatId}
          isOpen={extensionsOpen}
          onOpenChange={setExtensionsOpen}
          agents={agents}
          mainSummary={data.extensions}
          isRunning={group.isRunning}
        />
      )}
    </div>
  );
}
