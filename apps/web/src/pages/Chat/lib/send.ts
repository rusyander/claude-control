import type { SendOutcome } from '@shared/lib/agent-runs';
import { unsupportedUploadNames } from './uploads';

/**
 * Что делать с нажатием «Отправить» — и что при этом станет с набранным.
 *
 * Правило, ради которого решение вынесено сюда: набранный текст и вложения
 * принадлежат человеку до тех пор, пока сообщение не принято. Раньше поле
 * очищалось ДО запроса, а вложения — сразу по клику, поэтому любой отказ
 * (занятый прогон, файл не того типа) стирал написанное безвозвратно: черновик
 * в localStorage уходил вместе с ним, и всё приходилось набирать заново.
 */
export type SendPlan =
  /** Пустой текст — ничего не делаем, поле не трогаем. */
  | { action: 'ignore' }
  /** Вложение панель передать не сможет — отказ до сети, текст и чипы на месте. */
  | { action: 'reject'; names: string[] }
  /** Отправляем; очищать поле можно только после ответа сервера. */
  | { action: 'dispatch'; prompt: string };

export function planSend(text: string, files: { name: string }[]): SendPlan {
  const prompt = text.trim();
  if (!prompt) return { action: 'ignore' };

  const names = unsupportedUploadNames(files);
  if (names.length > 0) return { action: 'reject', names };

  return { action: 'dispatch', prompt };
}

/** Очищать ли поле ввода: только когда сервер сообщение ПРИНЯЛ. */
export function clearsComposer(outcome: SendOutcome): boolean {
  return outcome.ok;
}
