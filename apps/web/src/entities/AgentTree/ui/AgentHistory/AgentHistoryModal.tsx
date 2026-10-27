import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@shared/ui/modal';
import { Typography } from '@shared/ui/typography';
import { AgentTranscript } from '../AgentTranscript/AgentTranscript';
import { AgentHistorySessions } from './AgentHistorySessions';
import type { AgentHistoryModalProps, HistoryPick } from './AgentHistory.types';
import styles from './AgentHistory.module.scss';

/**
 * Окно «История агентов»: все сессии разговора новыми первыми — у каждой
 * главный агент одной строкой и её субагенты; щелчок по субагенту открывает
 * справа его шаги (тот же ход, что в «Плане агента»), в том числе субагента
 * прошлой сессии — по ключу ЕГО сессии. Только чтение: источник — транскрипты CLI.
 */
export function AgentHistoryModal({
  history,
  isOpen,
  onOpenChange,
  isRunning,
  isLoading,
}: AgentHistoryModalProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<HistoryPick | undefined>();
  useEffect(() => {
    if (!isOpen) setPicked(undefined);
  }, [isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('agentTree.history.title')}
      {...(history
        ? {
            description: t('agentTree.history.summary', {
              sessions: history.sessions.length,
              agents: history.agentCount,
            }),
          }
        : {})}
      size="xl"
      bodyFill
    >
      <div className={styles.layout} data-agent-history-modal>
        <AgentHistorySessions
          history={history}
          isLoading={isLoading}
          isRunning={isRunning}
          picked={picked}
          onPick={setPicked}
        />
        <div className={styles.steps}>
          {picked ? (
            <AgentTranscript
              chatId={picked.chatId}
              agentId={picked.agentId}
              onClose={() => setPicked(undefined)}
            />
          ) : (
            <Typography variant="body-sm" color="subtle" as="p" className={styles.pick}>
              {t('agentTree.history.pick')}
            </Typography>
          )}
        </div>
      </div>
    </Modal>
  );
}
