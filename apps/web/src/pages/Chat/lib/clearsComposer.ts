import type { SendOutcome } from '@shared/lib/agent-runs';

/** Очищать ли поле ввода: только когда сервер сообщение ПРИНЯЛ. */
export function clearsComposer(outcome: SendOutcome): boolean {
  return outcome.ok;
}
