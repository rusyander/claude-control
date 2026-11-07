import { useTranslation } from 'react-i18next';
import {
  AgentHistoryButton,
  LOOK_TONE,
  NO_FILTERS,
  nodeLook,
  ownerOf,
  openAgentPane,
  useCoreAgents,
  workerNodes,
} from '@entities/AgentTree';
import { StatusDot } from '@shared/ui/status-dot';
import { Typography } from '@shared/ui/typography';
import type { GroupAgentsProps } from './GroupAgents.types';
import styles from './GroupAgents.module.scss';

/** Сколько переходов показывать в карточке: дальше — «ещё N». */
const SHOWN = 6;

/**
 * Агенты группы в её карточке хаба — по журналу ядра, у любого CLI: сколько субагентов и фоновых
 * работ идёт и сколько закончило, и переход к каждому — чат группы открывается сразу с этим узлом
 * справа. Идущие — первыми: за ними и заходят. Ниже — кнопка «Агенты» с окном всей истории (тот же
 * запрос, второго опроса нет).
 */
export function GroupAgents({ chatId, group, onOpen }: GroupAgentsProps) {
  const { t } = useTranslation();
  const { data } = useCoreAgents(chatId, NO_FILTERS, group.isRunning);
  const nodes = data?.nodes ?? [];
  if (nodes.length === 0) return null;
  const { rows, running, finished } = workerNodes(nodes);
  const shown = rows.slice(0, SHOWN);
  const more = rows.length - shown.length;

  return (
    <div className={styles.root} data-group-agents={rows.length}>
      {rows.length > 0 && (
        <Typography variant="caption" color="subtle" as="span" className={styles.counts}>
          {t('agentTree.group.title')}: {t('agentTree.group.counts', { running, finished })}
        </Typography>
      )}
      {shown.length > 0 && (
        <ul className={styles.list}>
          {shown.map((node) => {
            const look = nodeLook(node, ownerOf(nodes, node));
            const description =
              node.briefExcerpt?.split('\n')[0] || t(`agentTree.kind.${node.kind}`);
            return (
              <li key={`${node.taskId}:${node.nodeId}`}>
                <button
                  type="button"
                  className={styles.jump}
                  title={t('agentTree.group.jumpHint', { description })}
                  data-group-agent-jump={node.nodeId}
                  data-agent-state={look}
                  onClick={() => {
                    openAgentPane(chatId, node.nodeId);
                    onOpen(chatId);
                  }}
                >
                  <StatusDot tone={LOOK_TONE[look]} pulse={look === 'running'} />
                  <span className={styles.jumpText}>{description}</span>
                </button>
              </li>
            );
          })}
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
    </div>
  );
}
