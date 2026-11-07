import { useTranslation } from 'react-i18next';
import type { AgentNode } from '@agentdeck/contracts/core/agents';
import { StatusDot } from '@shared/ui/status-dot';
import { LOOK_TONE, lookText, nodeLook } from '../../model/coreAgents';
import styles from './AgentHistory.module.scss';

/**
 * Состояние узла словом и точкой: цвет не единственный признак — слово рядом («идёт», «завершён
 * (код 0)», «осиротел», «висит»). `owner` — владелец узла: по его аварийному концу потерянная
 * фоновая работа читается как «осиротел — потерян».
 */
export function NodeStatus({
  node,
  owner,
}: {
  node: Pick<AgentNode, 'kind' | 'status' | 'signals' | 'exitCode'>;
  owner?: Pick<AgentNode, 'status'>;
}) {
  const { t } = useTranslation();
  const look = nodeLook(node, owner);
  const text = lookText(node, owner);
  return (
    <span className={styles.status} data-node-status={look}>
      <StatusDot tone={LOOK_TONE[look]} pulse={look === 'running'} />
      {t(text.key, text.values)}
    </span>
  );
}
