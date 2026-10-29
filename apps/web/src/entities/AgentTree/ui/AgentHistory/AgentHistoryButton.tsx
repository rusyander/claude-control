import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@shared/lib/cn';
import { useAgentHistory } from '../../api/agentTreeApi';
import { hasHistory, liveCountParts } from '../../model/agentHistory';
import { AgentHistoryModal } from './AgentHistoryModal';
import type { AgentHistoryButtonProps } from './AgentHistory.types';
import styles from './AgentHistory.module.scss';

/**
 * Число в «сейчас: …»: жирным и своим цветом — агенты цветом «идёт», субагенты
 * акцентом; ноль — приглушённо и обычным начертанием. Цвет не единственный
 * признак: число отличается и начертанием, и от слова рядом.
 */
function LiveCount({ count, tone }: { count: number; tone: 'agents' | 'subagents' }) {
  return (
    <span
      className={cn(
        styles.liveCount,
        count > 0 && (tone === 'agents' ? styles.liveCountAgents : styles.liveCountSubagents),
      )}
      data-live-count={tone}
    >
      {count}
    </span>
  );
}

/**
 * Кнопка «История агентов · N» — у разговора с хоть одной сессией, с
 * субагентами или без: N — субагентов во всех сессиях (у группы — во всех её
 * звеньях). Рядом — кто работает прямо сейчас («сейчас: 1 агент · 2
 * субагента»), тем же ответом сервера и тем же опросом. Окно — по щелчку.
 */
export function AgentHistoryButton({ chatId, isRunning, className }: AgentHistoryButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const query = useAgentHistory(chatId, isRunning);
  const history = query.data;
  if (!hasHistory(history)) return null;
  const live = liveCountParts(history, t);

  return (
    <span className={cn(styles.liveRow, className)}>
      <button
        type="button"
        className={styles.open}
        title={t('agentTree.history.openHint', { sessions: history.sessions.length })}
        data-agent-history-open={history.agentCount}
        onClick={() => setOpen(true)}
      >
        {t('agentTree.history.open', { count: history.agentCount })}
      </button>
      <span
        className={cn(styles.live, !live && styles.liveNone)}
        title={t('agentTree.history.liveHint')}
        data-agent-history-live={`${history.live.agents}:${history.live.subagents}`}
      >
        {live ? (
          <>
            {t('agentTree.history.liveLead')} <LiveCount count={live.agents} tone="agents" />
            {` ${live.agentsWord} · `}
            <LiveCount count={live.subagents} tone="subagents" />
            {` ${live.subagentsWord}`}
          </>
        ) : (
          t('agentTree.history.liveNone')
        )}
      </span>
      <AgentHistoryModal
        history={history}
        isOpen={open}
        onOpenChange={setOpen}
        isRunning={isRunning}
        isLoading={query.isLoading}
      />
    </span>
  );
}
