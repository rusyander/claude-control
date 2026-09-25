import type { RunStatus } from '@shared/lib/agent-runs';

/** Текст повода: ключ словаря и подстановки — одни и те же для тоста и системы. */
export interface RunNotice {
  tone: 'success' | 'warning' | 'error';
  key: string;
  params: Record<string, string>;
  /**
   * Нужен ли тост. Вопрос ребёнка открытого чата уже стоит карточкой прямо
   * здесь — тостом звать некуда; но на скрытой вкладке карточку не видно, и
   * системное уведомление о нём всё равно нужно.
   */
  toast: boolean;
}

/**
 * Чем звать человека про фоновый прогон, который кончился, спросил или упал.
 * `child` — ребёнок разделения открытого чата (его зовём по названию чата),
 * `name` — короткое имя проекта для остальных.
 */
export function backgroundRunNotice(
  status: RunStatus,
  child: { title: string } | undefined,
  name: string,
): RunNotice {
  if (child) {
    const params = { title: child.title };
    if (status === 'error')
      return { tone: 'error', key: 'projects.notifyChildError', params, toast: true };
    if (status === 'waiting')
      return { tone: 'warning', key: 'projects.notifyChildWaiting', params, toast: false };
    return { tone: 'success', key: 'projects.notifyChildDone', params, toast: true };
  }
  const params = { name };
  if (status === 'waiting')
    return { tone: 'warning', key: 'projects.notifyWaiting', params, toast: true };
  if (status === 'error')
    return { tone: 'error', key: 'projects.notifyError', params, toast: true };
  return { tone: 'success', key: 'projects.notifyDone', params, toast: true };
}

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
