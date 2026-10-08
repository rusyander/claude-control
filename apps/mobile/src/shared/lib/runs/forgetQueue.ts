import { remove } from './remove';

/** Забыть сохранённую очередь разговора (ушла, отменена или протухла). */
export async function forgetQueue(...ids: (string | undefined)[]): Promise<void> {
  for (const id of ids) if (id) await remove(id);
}
