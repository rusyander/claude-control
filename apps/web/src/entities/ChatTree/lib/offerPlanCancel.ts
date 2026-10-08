import type { TFunction } from 'i18next';
import { toast } from '@shared/lib/toast';
import { focusPlanCancel } from './focusPlanCancel';
import { isPlanRunningRefusal } from './planCancelOffer';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

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
