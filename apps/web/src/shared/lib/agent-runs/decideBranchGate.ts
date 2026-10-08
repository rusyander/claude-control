import { apiClient, messageFromPayload } from '@shared/api/client';
import { rebuildStatuses } from './agent-runs.statuses';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { getRun } from './getRun';

/**
 * Ответить воротам ветки. Карточку гасим только на успехе, и это не
 * осторожность: «завести копию» может не пройти у самого git (занятое имя,
 * грязная копия), а придержанная правка всё это время жива. Сняли бы карточку
 * сразу — человек остался бы с идущим прогоном, который стоит, и без единой
 * кнопки, чтобы ответить.
 */
export async function decideBranchGate(
  id: string,
  toolUseId: string,
  choice: 'copy' | 'here' | 'stop',
  branch?: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const run = getRun(id);
  const key = run.id || id;
  const current = runs.get(key);
  const target = current?.serverRunId ?? key;
  try {
    const { data } = await apiClient.post(`/chat/${target}/branch-decision`, {
      toolUseId,
      choice,
      ...(branch ? { branch } : {}),
    });
    const answer = data as { ok?: unknown; path?: unknown };
    if (answer?.ok !== true) {
      // Тот же путь текста, что у отказа с исключением ниже: код сервера — на
      // языке интерфейса, сырой русский `message` — только запасной (F-336).
      const text = messageFromPayload(answer);
      return { ok: false, ...(text ? { error: text } : {}) };
    }
    const after = runs.get(key);
    if (after) {
      runs.set(key, {
        ...after,
        branchGates: after.branchGates.filter((gate) => gate.toolUseId !== toolUseId),
      });
      rebuildStatuses();
      emit();
    }
    return { ok: true, ...(typeof answer.path === 'string' ? { path: answer.path } : {}) };
  } catch (error) {
    // Текст по коду сервера на языке интерфейса (умерший запрос — «истёк»),
    // русский `message` — запасной.
    const body = (error as { response?: { data?: unknown } })?.response?.data;
    const text = messageFromPayload(body);
    return { ok: false, ...(text ? { error: text } : {}) };
  }
}
