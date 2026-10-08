import { fetch as streamingFetch } from 'expo/fetch';
import { apiUrl } from '../../shared/api/client';
import { authHeaders } from '../../shared/api/authHeaders';

/**
 * «Стоп» хода с возвратом: обрыв запроса его больше не снимает. Сервер без
 * возврата маршрута не знает (404) — ему хватает оборванного запроса.
 */
export async function stopPanelAgent(conversationId: string): Promise<void> {
  try {
    await streamingFetch(apiUrl(`/agent/run/${encodeURIComponent(conversationId)}/stop`), {
      method: 'POST',
      headers: authHeaders(),
    });
  } catch {
    // Связи нет — сервер снимет отцепленный ход сам по сроку.
  }
}
