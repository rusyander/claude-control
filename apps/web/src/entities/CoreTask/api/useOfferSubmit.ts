import { useRef, useState } from 'react';
import type { CommandDraft } from '../model/command';
import { failureOf, failureReason } from '../model/failure';
import { useCoreCommand } from './useCoreTasks';

export type OfferSubmitState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'applied' }
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * Отправка перевода одной командой. Замок — `useRef`: двойной клик в одном кадре отправил бы два
 * конверта с разными `cmdId`. Отказ ядра — его словами, сбой прокладки — её словами.
 */
export function useOfferSubmit(onDone?: () => void) {
  const command = useCoreCommand();
  const lock = useRef(false);
  const [state, setState] = useState<OfferSubmitState>({ status: 'idle' });

  const submit = async (draft: CommandDraft): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setState({ status: 'sending' });
    try {
      const outcome = await command.mutateAsync(draft);
      if (outcome.status === 'rejected') {
        setState({ status: 'rejected', reason: outcome.reason ?? outcome.code ?? '' });
        return;
      }
      setState({ status: 'applied' });
      onDone?.();
    } catch (error) {
      setState({ status: 'failed', reason: failureReason(failureOf(error)) });
    } finally {
      lock.current = false;
    }
  };

  return { state, submit };
}
