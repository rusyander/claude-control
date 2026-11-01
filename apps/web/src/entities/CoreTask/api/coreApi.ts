import { panelCorePath } from '@agentdeck/contracts/core/panel-api';
import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import { apiClient } from '@shared/api/client';
import { commandEnvelope, pageLoadId, type CommandDraft } from '../model/command';

/**
 * Адреса ядра — из ОДНОГО списка контрактов (`CORE_PANEL_ROUTES`): клиент строит путь через
 * `panelCorePath`, прокладка сервера регистрирует пересылку по тому же списку. `apiClient` сам
 * ставит `/api`, поэтому у пути он срезан.
 */
export function coreUrl(path: string, params?: Record<string, string>): string {
  return panelCorePath(path, params).replace(/^\/api/, '');
}

export async function coreGet<T>(
  path: string,
  params?: Record<string, string>,
  query?: Record<string, string>,
): Promise<T> {
  const { data } = await apiClient.get<T>(coreUrl(path, params), { params: query });
  return data;
}

export async function corePost<T>(path: string, body: unknown): Promise<T> {
  const { data } = await apiClient.post<T>(coreUrl(path), body);
  return data;
}

/** Одноразовое число этой загрузки страницы — ядро чеканит его само (P23: панель не чеканит). */
export async function fetchNonce(page: string = pageLoadId()): Promise<string> {
  const { nonce } = await coreGet<{ nonce: string; expiresAt: number }>('/nonce', undefined, {
    page,
  });
  return nonce;
}

/** Команда задачи: сначала число страницы, затем сам конверт; ответ — сохранённый исход ядра. */
export async function sendCoreCommand(draft: CommandDraft): Promise<CommandOutcome> {
  const page = pageLoadId();
  const nonce = await fetchNonce(page);
  return corePost<CommandOutcome>('/commands', commandEnvelope(draft, nonce, page));
}
