import { useRef, useState } from 'react';
import { failureOf, failureReason, useCoreCommand, type CommandDraft } from '@entities/CoreTask';

export type SubmitState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'applied' }
  | { status: 'rejected'; code: string; reason: string }
  | { status: 'failed'; reason: string };

/**
 * Отправка команд карточки по одной, по порядку (грант раньше ответа). Замок — `useRef`, а не
 * состояние: два быстрых нажатия попадают в один кадр до перерисовки, и состояние ещё «свободно»
 * — второй ответ ушёл бы в ядро вторым конвертом. Принятый ответ замок не снимает: вопрос закрыт.
 */
export function useAskSubmit() {
  const command = useCoreCommand();
  const lock = useRef(false);
  const [state, setState] = useState<SubmitState>({ status: 'idle' });

  const submit = async (drafts: CommandDraft[]): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setState({ status: 'sending' });
    for (const draft of drafts) {
      try {
        const outcome = await command.mutateAsync(draft);
        if (outcome.status === 'rejected') {
          setState({
            status: 'rejected',
            code: outcome.code ?? '',
            reason: outcome.reason ?? outcome.code ?? '',
          });
          lock.current = false;
          return;
        }
      } catch (error) {
        // Дословно словами ядра или прокладки: эта строка объясняет, почему ответ не принят.
        setState({ status: 'failed', reason: failureReason(failureOf(error)) });
        lock.current = false;
        return;
      }
    }
    setState({ status: 'applied' });
  };

  return { state, submit };
}
