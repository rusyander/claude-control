import axios from 'axios';

/** Код отказа 409 «разделение этого чата уже идёт» (сервер, `split-routes.ts`). */
const PLAN_RUNNING = 'split-plan-running';

/** Отказ «Разделить», потому что план этого чата ещё идёт. */
export function isPlanRunningRefusal(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return false;
  const data = error.response.data as { messageCode?: unknown } | undefined;
  return data?.messageCode === PLAN_RUNNING;
}
