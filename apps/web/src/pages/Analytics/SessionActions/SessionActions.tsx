import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type { SessionLocation } from '@agentdeck/contracts';
import { toast } from '@shared/lib/toast';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Modal } from '@shared/ui/modal';
import { useLocateSession, useStopPanelChat, useStopSessionProcess } from '@entities/Analytics';
import { goPlan } from '../model/sessionActions';
import type { SessionActionsProps } from './SessionActions.types';
import styles from './SessionActions.module.scss';
import { hostLabel } from '../lib/hostLabel';
import { SessionWhereDetails } from './SessionWhereDetails/SessionWhereDetails';
import { WhereModal } from './WhereModal/WhereModal';
import { lowerFirst } from '../lib/lowerFirst';
import { stopPlan } from '../model/stopPlan';
import { stopOutcome } from '../model/stopOutcome';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * «Перейти» и «Остановить» у строки вкладки «Сессии».
 *
 * Где идёт сессия, выясняется по клику на сервере (прогоны панели, процессы CLI
 * с номером сессии в командной строке) — список сессий этого не хранит, а ответ
 * нужен на сейчас. Окно подтверждения называет ровно то, что будет снято:
 * номер процесса, где он запущен, когда и какой командой; стоп сверяет это же
 * на сервере и не трогает процесс, если под номером уже другой.
 */
export function SessionActions({ session }: SessionActionsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const locate = useLocateSession();
  const stopProcess = useStopSessionProcess();
  const stopChat = useStopPanelChat();
  const [asking, setAsking] = useState<'go' | 'stop'>();
  const [whereOf, setWhereOf] = useState<SessionLocation>();
  const [stopOf, setStopOf] = useState<SessionLocation>();
  // Сервер сказал «из этой сессии запущена панель», а окно этого не знало (гонка).
  const [panelAsked, setPanelAsked] = useState(false);

  // Путь строкой: типизированного дерева маршрутов нет — приведение, как у палитры.
  const openChat = (id: string): void => void navigate({ to: '/chat', search: { id } } as never);

  const onLocated = (mode: 'go' | 'stop', location: SessionLocation): void => {
    if (mode === 'stop') {
      setPanelAsked(false);
      setStopOf(location);
      return;
    }
    const plan = goPlan(location);
    if (plan.kind === 'chat') openChat(plan.id);
    else setWhereOf(location);
  };

  const ask = (mode: 'go' | 'stop'): void => {
    setAsking(mode);
    locate.mutate(session.sessionId, {
      onSuccess: (location) => onLocated(mode, location),
      onError: (error) =>
        toast.error(t('analytics.sessionLocateFailed', { reason: toErrorMessage(error) })),
      onSettled: () => setAsking(undefined),
    });
  };

  const plan = stopOf ? stopPlan(stopOf.where) : undefined;
  const withPanel = plan?.kind === 'process' && (plan.ownsPanel || panelAsked);

  const confirmStop = (): void => {
    if (!plan || plan.kind === 'nothing') return;
    if (plan.kind === 'panel') {
      stopChat.mutate(plan.chatId, {
        onSuccess: ({ ok }) => {
          if (ok) toast.success(t('analytics.sessionChatStopped'));
          else toast.info(t('analytics.sessionChatNotRunning'));
          setStopOf(undefined);
        },
        onError: (error) =>
          toast.error(t('analytics.sessionStopFailed', { reason: toErrorMessage(error) })),
      });
      return;
    }
    const body = { pid: plan.pid, startedAt: plan.startedAt, allowPanel: withPanel };
    stopProcess.mutate(
      { sessionId: session.sessionId, body },
      {
        onSuccess: (result) => {
          if (result.result === 'owns-panel') {
            setPanelAsked(true);
            return;
          }
          const outcome = stopOutcome(result);
          toast[outcome.tone](t(outcome.key, outcome.params));
          setStopOf(undefined);
        },
        onError: (error) =>
          toast.error(t('analytics.sessionStopFailed', { reason: toErrorMessage(error) })),
      },
    );
  };

  return (
    <>
      <Stack
        direction="row"
        align="center"
        gap="var(--spacing-2xs)"
        className={styles.sessionActions}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => ask('go')}
          isLoading={asking === 'go'}
          disabled={asking !== undefined}
          aria-label={`${t('analytics.sessionGo')}: ${session.displayName}`}
        >
          {t('analytics.sessionGo')}
        </Button>
        {session.isActive ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => ask('stop')}
            isLoading={asking === 'stop'}
            disabled={asking !== undefined}
            aria-label={`${t('analytics.sessionStop')}: ${session.displayName}`}
          >
            {t('analytics.sessionStop')}
          </Button>
        ) : (
          // Пустое место ровно под «Остановить» на языке интерфейса: без него
          // «Перейти» и колонка токенов у завершённых строк уезжали вправо.
          <Button variant="ghost" size="sm" className={styles.stopSlot} aria-hidden tabIndex={-1}>
            {t('analytics.sessionStop')}
          </Button>
        )}
      </Stack>

      <WhereModal location={whereOf} onClose={() => setWhereOf(undefined)} />

      <Modal
        isOpen={stopOf !== undefined}
        onOpenChange={(open) => !open && setStopOf(undefined)}
        title={t('analytics.sessionStopTitle')}
        size="fit"
        footer={
          <>
            <Button onClick={() => setStopOf(undefined)}>{t('common.cancel')}</Button>
            {plan && plan.kind !== 'nothing' && (
              <Button
                variant="danger"
                onClick={confirmStop}
                isLoading={stopProcess.isPending || stopChat.isPending}
              >
                {withPanel
                  ? t('analytics.sessionStopWithPanel')
                  : t('analytics.sessionStopConfirm')}
              </Button>
            )}
          </>
        }
      >
        {stopOf && plan && (
          <Stack gap="var(--spacing-md)">
            {plan.kind === 'panel' && (
              <Typography variant="body-sm">
                {t('analytics.sessionStopPanel', { project: session.displayName })}
              </Typography>
            )}
            {plan.kind === 'process' && (
              <Typography variant="body-sm">
                {t('analytics.sessionStopProcess', {
                  pid: plan.pid,
                  // Внутри фразы — со строчной: «процесс 42 (в терминале — вне панели)».
                  where: lowerFirst(hostLabel(stopOf, t)),
                })}
              </Typography>
            )}
            {plan.kind === 'nothing' && (
              <Typography variant="body-sm" role="status">
                {plan.reason === 'finished'
                  ? t('analytics.sessionFinishedNow')
                  : t('analytics.sessionWhereUnidentified')}
              </Typography>
            )}
            {panelAsked && (
              <Typography variant="body-sm" weight="medium" color="danger" role="alert">
                {t('analytics.sessionOwnsPanelAsk')}
              </Typography>
            )}
            {withPanel && (
              <Typography variant="body-sm" color="danger">
                {t('analytics.sessionStopOwnsPanel')}
              </Typography>
            )}
            <SessionWhereDetails location={stopOf} />
          </Stack>
        )}
      </Modal>
    </>
  );
}
