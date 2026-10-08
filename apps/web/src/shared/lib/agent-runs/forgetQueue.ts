import { remove } from './remove';

/** Забыть сохранённую очередь разговора (ушла, отменена или протухла). */
export function forgetQueue(...ids: (string | undefined)[]): void {
  for (const id of ids) if (id) remove(id);
}
