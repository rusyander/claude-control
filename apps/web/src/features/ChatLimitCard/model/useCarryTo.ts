import { useEffect, useRef, useState } from 'react';
import type { HandoffRefusal } from '@agentdeck/contracts/chat-handoff';
import { useUpdateSettings } from '@entities/AppConfig';
import { useApplyCarry, useCarryPlan } from '@entities/Portability';
import { carryCandidateOf } from './chatLimit';

export type CarryState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'carried'; cli: string }
  /** Разговор не кандидат или неготов: `reason` — предохранитель продолжения, если назван. */
  | { status: 'not-carried'; cli: string; reason?: HandoffRefusal }
  | { status: 'failed'; reason: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * «Перенести в X» одним кликом (P171, П6.1): активный провайдер панели → X, затем перенос ЭТОГО
 * разговора тем же путём, что вкладка «Перенос», — план читается заново (кандидаты считаются
 * к активному провайдеру), этот разговор находится по ключу и уходит одним `carry/apply`.
 * Неготовый или не найденный — причина в карточке, перенос не зовётся.
 *
 * Разговор ищется по id, известному ПОСЛЕ смены провайдера, а не в миг клика: карточка нового
 * разговора встаёт раньше, чем список чатов узнаёт его id, и клик в это окно искал в свежем плане
 * пустой id — «не попал в список переноса», хотя разговор в плане был (живой прогон 08.11).
 */
export function useCarryTo(conversationId: string | undefined) {
  const settings = useUpdateSettings({ silentError: true });
  const plan = useCarryPlan();
  const apply = useApplyCarry();
  const lock = useRef(false);
  const latestId = useRef(conversationId);
  useEffect(() => {
    latestId.current = conversationId;
  }, [conversationId]);
  const [state, setState] = useState<CarryState>({ status: 'idle' });

  const carry = async (cli: string): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setState({ status: 'sending' });
    try {
      await settings.mutateAsync({ provider: cli });
      const fresh = await plan.refetch();
      const candidate = carryCandidateOf(fresh.data, latestId.current);
      if (!candidate || !candidate.ready) {
        setState({
          status: 'not-carried',
          cli,
          ...(candidate?.reason ? { reason: candidate.reason } : {}),
        });
        return;
      }
      const answer = await apply.mutateAsync([candidate.key]);
      const outcome = answer.outcomes.find((o) => o.key === candidate.key);
      if (outcome?.carried) setState({ status: 'carried', cli });
      else
        setState({
          status: 'not-carried',
          cli,
          ...(outcome?.reason ? { reason: outcome.reason } : {}),
        });
    } catch (error) {
      setState({ status: 'failed', reason: messageOf(error) });
    } finally {
      lock.current = false;
    }
  };

  return { state, carry };
}
