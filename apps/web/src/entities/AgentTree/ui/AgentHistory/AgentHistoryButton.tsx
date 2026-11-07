import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/cn';
import { useAgentsLive, useCoreAgents, useLiveTaskIds } from '../../api/agentTreeApi';
import { NO_FILTERS, runningBackground } from '../../model/coreAgents';
import { AgentHistoryModal } from './AgentHistoryModal';
import type { AgentHistoryButtonProps, AgentHistoryCardProps } from './AgentHistory.types';
import styles from './AgentHistory.module.scss';

/**
 * Карточка «Агенты · фоном: N» — кнопка окна и число фоновых работ, идущих сейчас. Чистая: всё
 * считается из узлов, пришедших от ядра.
 */
export function AgentHistoryCard({ nodes, onOpen, className }: AgentHistoryCardProps) {
  const { t } = useTranslation();
  const bg = runningBackground(nodes);
  return (
    <span className={cn(styles.card, className)} data-agent-history-card>
      <button
        type="button"
        className={styles.open}
        title={t('agentTree.history.openHint')}
        data-agent-history-open={nodes.length}
        onClick={onOpen}
      >
        {t('agentTree.history.open')}
      </button>
      <span
        className={cn(styles.bg, bg > 0 && styles.bgLive)}
        title={t('agentTree.history.bgHint')}
        data-agent-history-bg={bg}
      >
        {bg > 0 ? t('agentTree.history.bg', { count: bg }) : t('agentTree.history.bgNone')}
      </span>
    </span>
  );
}

/**
 * Кнопка «Агенты» над полем ввода чата — у любого CLI: узлы приходят из журнала ядра по
 * `conversationId`, не из транскрипта Claude. Узлов нет — кнопки нет. Идущие задачи
 * подписаны на поток дерева: «фоном: N» меняется без F5.
 */
export function AgentHistoryButton({ chatId, isRunning, className }: AgentHistoryButtonProps) {
  const [open, setOpen] = useState(false);
  const query = useCoreAgents(chatId, NO_FILTERS, isRunning);
  const nodes = query.data?.nodes;
  useAgentsLive(chatId, useLiveTaskIds(nodes));
  if (!nodes || nodes.length === 0) return null;
  return (
    <>
      <AgentHistoryCard
        nodes={nodes}
        onOpen={() => setOpen(true)}
        {...(className ? { className } : {})}
      />
      <AgentHistoryModal
        chatId={chatId}
        isOpen={open}
        onOpenChange={setOpen}
        isRunning={isRunning}
      />
    </>
  );
}
