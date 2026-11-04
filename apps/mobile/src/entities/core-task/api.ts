import { useEffect, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { fetch as streamingFetch } from 'expo/fetch';
import { getRandomBytes } from 'expo-crypto';
import type { TaskReply, TasksReply } from '@agentdeck/contracts/core/panel-api';
import { api, apiUrl } from '../../shared/api/client';
import { authHeaders } from '../../shared/api/authHeaders';
import { activePanel, currentConnection } from '../../shared/api/connection';
import { signedCoreCommand } from '../../shared/api/signing/coreCommand';
import { freshNonce, loadKey } from '../../shared/api/signing/keyStore';
import type { CorePermitAsk } from '@agentdeck/contracts/chat-handoff';
import type { Dictionary } from '../../shared/config/i18n';
import {
  askCardOf,
  corePermitDrafts,
  takeSseFrames,
  uuidv7,
  type CoreAskCard,
  type CoreCommandDraft,
} from './model';

/**
 * Сеть задач ядра на телефоне: всё — через прокладку панели (`/api/core/*`), ядро телефону
 * напрямую не видно. Ответ на вопрос — команда, подписанная ключом телефона (`proof.signature`):
 * с телефона ядро принимает только подпись устройства (суд `human-strict`).
 */

export const CORE_TASKS_KEY = 'core-tasks';
const POLL_MS = 3_000;

export function useCoreTasks(): UseQueryResult<TasksReply> {
  return useQuery({
    queryKey: [CORE_TASKS_KEY],
    queryFn: () => api.get<TasksReply>('/core/tasks'),
    refetchInterval: POLL_MS,
  });
}

export function useCoreTask(taskId: string | undefined): UseQueryResult<TaskReply> {
  return useQuery({
    queryKey: [CORE_TASKS_KEY, taskId],
    queryFn: () => api.get<TaskReply>(`/core/tasks/${encodeURIComponent(taskId ?? '')}`),
    enabled: Boolean(taskId),
    refetchInterval: POLL_MS,
  });
}

/**
 * Тексты и варианты вопросов задачи: вид задачи их не несёт, они в строках `human.asked`
 * журнала. Поток событий (`expo/fetch` — штатный fetch React Native поток не читает) открыт,
 * пока открыт экран: новый вопрос появляется без перезагрузки.
 */
export function useAskDetails(taskId: string | undefined): ReadonlyMap<string, CoreAskCard> {
  const [details, setDetails] = useState<ReadonlyMap<string, CoreAskCard>>(new Map());
  useEffect(() => {
    if (!taskId) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = (await streamingFetch(
          apiUrl(`/core/tasks/${encodeURIComponent(taskId)}/events`),
          { headers: authHeaders(), signal: controller.signal },
        )) as unknown as Response;
        const reader = response.body?.getReader();
        if (!response.ok || !reader) return;
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = takeSseFrames(buffer);
          buffer = rest;
          const cards = frames.map(askCardOf).filter((card): card is CoreAskCard => card !== null);
          if (cards.length > 0) {
            setDetails((prev) => {
              const next = new Map(prev);
              for (const card of cards) next.set(card.askId, card);
              return next;
            });
          }
        }
      } catch {
        // Экран закрыт или сеть порвалась: вопросы видны по виду задачи, ответ — своим текстом.
      }
    })();
    return () => controller.abort();
  }, [taskId]);
  return details;
}

export interface CoreSendResult {
  ok: boolean;
  /** Машинный код отказа ядра (`signature-invalid`, `no-key`…) или статус. */
  code: string;
}

/**
 * Команды по очереди, каждая со своей подписью и своим `cmdId`. Ключа для этой панели нет —
 * не отправляем вовсе: без подписи ядро ответ с телефона всё равно отвергнет.
 */
export async function sendCoreCommands(
  drafts: readonly CoreCommandDraft[],
): Promise<CoreSendResult> {
  const panel = activePanel(currentConnection())?.machineId ?? '';
  const key = panel ? await loadKey(panel) : undefined;
  if (!key) return { ok: false, code: 'no-key' };
  for (const draft of drafts) {
    const envelope = signedCoreCommand({
      key,
      panel,
      command: { ...draft, cmdId: uuidv7(getRandomBytes(10)) },
      nonce: freshNonce(),
      time: Date.now(),
    });
    try {
      const reply = await api.post<{ status?: string; code?: string }>('/core/commands', envelope);
      if (reply?.status !== 'applied')
        return { ok: false, code: reply?.code ?? reply?.status ?? '' };
    } catch (error) {
      const code = (error as { code?: string; status?: number }).code;
      return { ok: false, code: code ?? String((error as { status?: number }).status ?? '') };
    }
  }
  return { ok: true, code: 'applied' };
}

/**
 * Ответ на вопрос права задачи ядра из чата (карточка «Вопрос ядра» во «Вопросах» и в самом
 * чате): грант и ответ — подписанными командами ядра, а не маршрутом прогона панели, который
 * такую карточку отвергает (`core_permit_browser_only`). `no-grant` — гранта собрать не из чего.
 */
export async function answerCorePermit(
  card: CorePermitAsk,
  behavior: 'allow' | 'deny',
): Promise<CoreSendResult> {
  const drafts = corePermitDrafts(card, behavior);
  if (!drafts) return { ok: false, code: 'no-grant' };
  return sendCoreCommands(drafts);
}

/** Отказ отправки словами человека: нет ключа, нечем собрать грант, иначе — код ядра. */
export function corePermitFailure(t: Pick<Dictionary, 'coreTask'>, code: string): string {
  if (code === 'no-key') return t.coreTask.noKey;
  if (code === 'no-grant') return t.coreTask.permitNoGrant;
  return t.coreTask.refused(code);
}

/** Нажатие на карточке «Вопрос ядра»: отправка и причина отказа словами человека. */
export async function decideCorePermit(
  t: Pick<Dictionary, 'coreTask'>,
  card: CorePermitAsk,
  behavior: 'allow' | 'deny',
): Promise<{ ok: boolean; message?: string }> {
  const result = await answerCorePermit(card, behavior);
  return result.ok ? { ok: true } : { ok: false, message: corePermitFailure(t, result.code) };
}
