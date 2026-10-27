import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentStopResult } from '@agentdeck/contracts';
import {
  agentState,
  buildAgentTree,
  openAgentPane,
  useAgentPane,
  useStopAgent,
  visibleNodes,
  type AgentTreeNode,
} from '@entities/AgentTree';
import { AgentRow } from '../AgentRow/AgentRow';
import type { AgentTreeProps } from '../ChatProgressSheet.types';
import styles from '../AgentRow/AgentRow.module.scss';
import { nodeKey, treeKeyTarget } from './treeKeys';

/**
 * Дерево субагентов разговора — ARIA-дерево с одной остановкой Tab, как
 * дерево агентов у расширения VS Code: ↑↓ по видимым узлам, ← свернуть или к
 * родителю, → раскрыть или к первому вложенному, Home/End — края, Enter —
 * ход субагента справа (Escape его закрывает и возвращает фокус сюда).
 */
export function AgentTree({
  chatId,
  agents,
  isRunning,
  processAlive,
  canStop,
  now,
  onExtensions,
}: AgentTreeProps) {
  const { t } = useTranslation();
  const roots = useMemo(() => buildAgentTree(agents), [agents]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focused, setFocused] = useState<string>();
  const [notes, setNotes] = useState<ReadonlyMap<string, string>>(() => new Map());
  const pane = useAgentPane(chatId);
  const stopAgent = useStopAgent(chatId ?? '');
  const treeRef = useRef<HTMLUListElement>(null);
  const visible = visibleNodes(roots, collapsed);
  const tabStop = visible.find((node) => nodeKey(node) === focused) ?? visible[0];

  const focusNode = (node: AgentTreeNode | undefined): void => {
    if (!node) return;
    const key = nodeKey(node);
    setFocused(key);
    treeRef.current?.querySelector<HTMLElement>(`[data-agent-node="${CSS.escape(key)}"]`)?.focus();
  };

  const toggle = (node: AgentTreeNode, open?: boolean): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      const shut = open === undefined ? !next.has(node.agent.id) : !open;
      if (shut) next.add(node.agent.id);
      else next.delete(node.agent.id);
      return next;
    });
  };

  const open = (node: AgentTreeNode): void => {
    if (!chatId || !node.agent.agentId) return;
    setFocused(nodeKey(node));
    openAgentPane(chatId, node.agent.agentId);
  };

  const noteOf = (result: AgentStopResult): string =>
    t(`agentTree.stopState.${result.outcome}`, { message: result.message ?? '' });

  const stop = (agentId: string): void => {
    stopAgent.mutate(agentId, {
      onSuccess: (result) => setNotes((current) => new Map(current).set(agentId, noteOf(result))),
      onError: (error) =>
        setNotes((current) =>
          new Map(current).set(
            agentId,
            t('agentTree.stopState.failed', { message: error.message }),
          ),
        ),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    // Клавиши кнопок внутри узла (результат, «Остановить») — их собственные.
    const target = event.target as HTMLElement;
    if (target.getAttribute('role') !== 'treeitem') return;
    const current = visible.find((node) => nodeKey(node) === target.dataset.agentNode);
    if (!current) return;
    const action = treeKeyTarget(event.key, current, visible, collapsed);
    if (!action) return;
    event.preventDefault();
    if (action.kind === 'focus') focusNode(action.node);
    else if (action.kind === 'toggle') toggle(current, action.open);
    else open(current);
  };

  const renderNode = (node: AgentTreeNode) => {
    const { agent } = node;
    const view = agentState(agent, isRunning, processAlive);
    const hasChildren = node.children.length > 0;
    const isOpen = hasChildren && !collapsed.has(agent.id);
    const key = nodeKey(node);
    const agentId = agent.agentId;
    const stoppable = canStop && Boolean(chatId) && agentId !== undefined && view === 'running';
    const note = agentId && view === 'running' ? notes.get(agentId) : undefined;
    return (
      <AgentRow
        key={agent.id}
        agent={agent}
        isRunning={isRunning}
        {...(processAlive !== undefined ? { processAlive } : {})}
        now={now}
        tree={{
          level: node.level,
          ...(hasChildren ? { expanded: isOpen } : {}),
          isTabStop: tabStop !== undefined && nodeKey(tabStop) === key,
          isSelected: pane !== undefined && pane.agentId === agentId,
          onToggle: () => toggle(node),
          ...(agentId && chatId ? { onOpen: () => open(node) } : {}),
          ...(stoppable && agentId ? { onStop: () => stop(agentId) } : {}),
          ...(onExtensions && agentId ? { onExtensions: () => onExtensions(agentId) } : {}),
          isStopping: stopAgent.isPending && stopAgent.variables === agentId,
          ...(note ? { stopNote: note } : {}),
        }}
      >
        {isOpen && (
          <ul role="group" className={styles.group}>
            {node.children.map(renderNode)}
          </ul>
        )}
      </AgentRow>
    );
  };

  return (
    <ul
      ref={treeRef}
      role="tree"
      aria-label={t('agentTree.label')}
      className={styles.treeRoot}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const key = (event.target as HTMLElement).dataset.agentNode;
        if (key && (event.target as HTMLElement).getAttribute('role') === 'treeitem')
          setFocused(key);
      }}
      data-agent-tree
    >
      {roots.map(renderNode)}
    </ul>
  );
}
