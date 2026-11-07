import { useTranslation } from 'react-i18next';
import { formatDuration } from '@shared/lib/format-duration';
import { cn } from '@shared/lib/cn';
import { shortModel } from '../../model/agentTree';
import { nodeDurationMs } from '../../model/coreAgents';
import type { CoreTreeNode } from '../../model/coreAgents.types';
import { NodeStatus } from './NodeStatus';
import type { AgentNodeListProps } from './AgentHistory.types';
import styles from './AgentHistory.module.scss';

/** Заголовок строки: задание субагента или команда фоновой работы; нет — вид узла. */
function headline(entry: CoreTreeNode, kindLabel: string): string {
  return entry.node.briefExcerpt?.split('\n')[0]?.trim() || kindLabel;
}

/**
 * Дерево узлов чата: сеансы, под ними субагенты и фоновые работы — вложенными списками. У строки
 * вид, модель, состояние словом и время; щелчок открывает узел справа.
 */
export function AgentNodeList({ roots, picked, onPick, now }: AgentNodeListProps) {
  const { t } = useTranslation();

  const renderEntry = (entry: CoreTreeNode, owner?: CoreTreeNode['node']) => {
    const { node } = entry;
    const kindLabel = t(`agentTree.kind.${node.kind}`);
    const isPicked = picked?.taskId === node.taskId && picked.nodeId === node.nodeId;
    const model = shortModel(node.model ?? undefined);
    return (
      <li key={`${node.taskId}:${node.nodeId}`}>
        <button
          type="button"
          className={cn(styles.row, isPicked && styles.rowPicked)}
          aria-current={isPicked ? 'true' : undefined}
          data-agent-row={node.nodeId}
          data-agent-kind={node.kind}
          onClick={() => onPick({ taskId: node.taskId, nodeId: node.nodeId })}
        >
          <span className={styles.rowHead}>
            <span className={styles.kind}>{kindLabel}</span>
            <span className={styles.rowTitle}>{headline(entry, kindLabel)}</span>
          </span>
          <span className={styles.rowMeta}>
            <NodeStatus node={node} owner={owner} />
            {model && (
              <span className={styles.model} data-agent-model={node.model}>
                {model}
              </span>
            )}
            <span className={styles.muted}>{formatDuration(nodeDurationMs(node, now), t)}</span>
          </span>
        </button>
        {entry.children.length > 0 && (
          <ul className={styles.children}>
            {entry.children.map((child) => renderEntry(child, node))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul className={styles.tree} aria-label={t('agentTree.history.treeLabel')} data-agent-node-list>
      {roots.map((root) => renderEntry(root))}
    </ul>
  );
}
