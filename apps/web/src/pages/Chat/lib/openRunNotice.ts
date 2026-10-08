import type { RunStatus } from '@shared/lib/agent-runs';

/**
 * Повод про ОТКРЫТЫЙ разговор — только для системного уведомления скрытой
 * вкладки: тоста у открытого нет, он на экране.
 *
 * Конец хода — только переход из работы. Вопрос и падение — любой переход в них:
 * скрытая вкладка узнаёт конец хода опросом (прогон становится законченным, пока
 * тянется хвост), а вопрос или ошибку — хвостом, уже после. Тег уведомления у
 * прогона один, и второе заменяет первое, а не встаёт рядом. Смена разговора
 * сюда тоже попадает, но она бывает только на видимой вкладке, где уведомление
 * не показывается.
 */
export function openRunNotice(previous: RunStatus, next: RunStatus): string | undefined {
  if (previous === next) return undefined;
  if (next === 'waiting') return 'projects.notifyOpenWaiting';
  if (next === 'error') return 'projects.notifyOpenError';
  if (next === 'idle' && (previous === 'running' || previous === 'quiet'))
    return 'projects.notifyOpenDone';
  return undefined;
}
