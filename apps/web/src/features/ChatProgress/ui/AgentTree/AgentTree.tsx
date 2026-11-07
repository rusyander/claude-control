import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildAgentTree,
  NO_FILTERS,
  openAgentPane,
  useAgentPane,
  useCoreAgents,
  visibleNodes,
  withCoreFacts,
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
 * ход субагента справа (Escape его закрывает и возвращает фокус сюда). Модель, вызовы, расход
 * и вложенных субагентов строки берут у ядра — тот же запрос, что у кнопки «Агенты», второго
 * опроса нет; транскрипты субагентов панель не читает (этап 11, W3-17).
 */
export function AgentTree({ chatId, agents, isRunning, processAlive, now }: AgentTreeProps) {
  const { t } = useTranslation();
  const core = useCoreAgents(chatId, NO_FILTERS, isRunning);
  const coreNodes = core.data?.nodes;
  const roots = useMemo(
    () => buildAgentTree(withCoreFacts(agents, coreNodes ?? [])),
    [agents, coreNodes],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focused, setFocused] = useState<string>();
  const pane = useAgentPane(chatId);
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
    if (!chatId) return;
    setFocused(nodeKey(node));
    // Id вызова `Agent` — узел субагента у ядра: панель справа читает его из журнала ядра.
    openAgentPane(chatId, node.agent.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    // Клавиши кнопок внутри узла (результат) — их собственные.
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
    const hasChildren = node.children.length > 0;
    const isOpen = hasChildren && !collapsed.has(agent.id);
    const key = nodeKey(node);
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
          isSelected: pane !== undefined && pane.agentId === agent.id,
          onToggle: () => toggle(node),
          ...(chatId ? { onOpen: () => open(node) } : {}),
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
