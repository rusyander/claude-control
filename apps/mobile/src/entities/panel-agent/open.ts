import type { PanelAgentRunOutcome } from './run.types';
import { fetch as streamingFetch } from 'expo/fetch';
import { apiUrl } from '../../shared/api/client';

export async function open(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ response: Response } | PanelAgentRunOutcome> {
  try {
    // Ответ `expo/fetch` — не глобальный Response: отличаем обёрткой, а не instanceof.
    const response = (await streamingFetch(apiUrl(path), {
      ...init,
      signal,
    } as unknown as Parameters<typeof streamingFetch>[1])) as unknown as Response;
    return { response };
  } catch (error) {
    if (signal.aborted) return { ok: false, message: 'aborted', aborted: true };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
