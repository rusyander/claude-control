import { useRef, useState } from 'react';
import { failureOf, failureReason, useCoreCommand, type CommandDraft } from '@entities/CoreTask';

export type TakeoverSubmitState =
  | { status: 'idle' }
  | { status: 'sending'; kind: CommandDraft['kind'] }
  | { status: 'applied'; kind: CommandDraft['kind'] }
  | { status: 'rejected'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * Отправка одной команды перехвата. Замок — `useRef`: двойной клик попадает в один кадр до
 * перерисовки, и второй конверт ушёл бы в ядро новым `cmdId` (второй перехват — второй чат).
 * Отказ ядра показывается его словами; после ответа замок снимается — карточка уже другая.
 */
export function useTakeoverSubmit(onDone?: () => void) {
  const command = useCoreCommand();
  const lock = useRef(false);
  const [state, setState] = useState<TakeoverSubmitState>({ status: 'idle' });

  const submit = async (draft: CommandDraft): Promise<boolean> => {
    if (lock.current) return false;
    lock.current = true;
    setState({ status: 'sending', kind: draft.kind });
    try {
      const outcome = await command.mutateAsync(draft);
      if (outcome.status === 'rejected') {
        setState({ status: 'rejected', reason: outcome.reason ?? outcome.code ?? '' });
        return false;
      }
      setState({ status: 'applied', kind: draft.kind });
      onDone?.();
      return true;
    } catch (error) {
      setState({ status: 'failed', reason: failureReason(failureOf(error)) });
      return false;
    } finally {
      lock.current = false;
    }
  };

  return { state, submit };
}
