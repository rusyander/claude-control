import axios from 'axios';
import { messageFromPayload } from './client';

/**
 * Сообщение об ошибке, пригодное для показа пользователю. Сервер присылает
 * человеческий текст в теле ответа — берём его, а не сырой статус axios
 * («Request failed with status code 400» пользователю ничего не объясняет).
 */
export function toErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    return messageFromPayload(error.response?.data) ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
