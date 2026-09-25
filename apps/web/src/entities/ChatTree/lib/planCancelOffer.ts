import axios from 'axios';
import type { TFunction } from 'i18next';
import { toErrorMessage } from '@shared/api/client';
import { toast } from '@shared/lib/toast';

/** Код отказа 409 «разделение этого чата уже идёт» (сервер, `split-routes.ts`). */
const PLAN_RUNNING = 'split-plan-running';

/** Отказ «Разделить», потому что план этого чата ещё идёт. */
export function isPlanRunningRefusal(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return false;
  const data = error.response.data as { messageCode?: unknown } | undefined;
  return data?.messageCode === PLAN_RUNNING;
}

/** Довести человека до кнопки «Отменить план» в хабе — прокрутить и поставить фокус. */
export function focusPlanCancel(root: ParentNode = document): boolean {
  const button = root.querySelector<HTMLElement>('[data-plan-cancel]');
  if (!button) return false;
  button.scrollIntoView({ block: 'center', behavior: 'smooth' });
  button.focus();
  return true;
}

/**
 * Отказ 409 «разделение уже идёт» — с предложением, а не тупиком (W3-5): тост
 * говорит, что делать, и по клику ведёт к «Отменить план». Возвращает, взял
 * ли он ошибку на себя; иначе её показывает вызывающий, как раньше.
 */
export function offerPlanCancel(error: unknown, t: TFunction): boolean {
  if (!isPlanRunningRefusal(error)) return false;
  // Заголовок тоста — одна строка: действие уходит в текст, который переносится.
  toast.error(`${toErrorMessage(error)}. ${t('chat.cascade.hub.cancelPlan.offer')}`, {
    title: t('chat.cascade.hub.cancelPlan.offerTitle'),
    duration: 12_000,
    onClick: () => void focusPlanCancel(),
  });
  return true;
}
