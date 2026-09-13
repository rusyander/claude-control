import type {
  Platform,
  PlatformAgentAnswer,
  PlatformAgentOutcome,
  PlatformAgentSession,
  PlatformStatus,
} from '@agentdeck/contracts';

/**
 * Решения карточки «Агенты контура» — здесь, а не в разметке: прогон фронта
 * идёт в node и компонентов не рендерит, а решений тут ровно те, в которых
 * можно соврать человеку.
 */

/**
 * Почему спросить нельзя — либо пусто, если можно.
 *
 * Причины разные и чинятся в разных местах: контур выключен (тумблер в
 * карточке), ключа нет (мастер), агент не выбран (список тут же), вопрос пуст
 * (поле ввода). Одна серая кнопка без объяснения оставляет человека гадать,
 * какое из четырёх.
 */
export type AskBlocker = 'disabled' | 'no-token' | 'no-agent' | 'no-question' | '';

export function askBlocker(
  platform: Platform,
  hasToken: boolean,
  agentId: string,
  question: string,
): AskBlocker {
  if (!platform.enabled) return 'disabled';
  if (!hasToken) return 'no-token';
  if (!agentId) return 'no-agent';
  if (!question.trim()) return 'no-question';
  return '';
}

/**
 * Тон исхода. «Недоступно» — НЕ ошибка: агентов может не быть в лицензии
 * компании, и красный цвет послал бы человека чинить то, что не ломалось.
 * Объявленное автором завершение агента — тоже не поломка панели.
 */
export function outcomeTone(
  outcome: PlatformAgentOutcome,
): 'success' | 'warning' | 'danger' | 'neutral' {
  if (outcome === 'ok') return 'success';
  if (outcome === 'unavailable' || outcome === 'agent-error' || outcome === 'not-ready') {
    return 'warning';
  }
  return 'danger';
}

/**
 * Предупреждать ли, что ход не попал в сессию.
 *
 * Только когда контур сказал это прямо: ответ настоящий, а сессия не
 * пополнилась. Без признака (хода без сессии или старого ответа) молчим —
 * додумывать за чужое хранилище панель не станет.
 */
export function warnsSessionGap(answer: PlatformAgentAnswer | undefined): boolean {
  return answer?.outcome === 'ok' && answer.sessionRecorded === false;
}

/**
 * Предупреждать ли, что ответ оборван.
 *
 * Контур называет причину завершения только когда она есть, и всё, кроме
 * `stop`, означает, что агент не договорил: упёрся в предел вывода, был
 * остановлен фильтром, оборван по времени. Без этой строки на экране — обычный
 * зелёный «Ответил» и текст, обрывающийся на полуслове, а через переходник
 * такой обрывок уходит локальной модели как законченный ответ, и она на нём
 * действует.
 */
export function warnsCut(answer: PlatformAgentAnswer | undefined): boolean {
  if (answer?.outcome !== 'ok') return false;
  return answer.finishReason !== undefined && answer.finishReason !== 'stop';
}

/**
 * Что писать про переписку сессии.
 *
 * Утверждение «контур ничего не помнит» вправе появиться ТОЛЬКО после удачного
 * чтения: это факт про чужое хранилище, а не про наше незнание. Пока запрос
 * идёт — молчим, отказ чтения называем отказом, и число берём то, которое
 * прислал контур (`total`), а не длину показываемого списка: инструментные ходы
 * агента панель не рисует, но они в сессии есть.
 */
export type SessionLine = 'kept' | 'empty' | 'failed' | 'unknown';

export function sessionLine(state: {
  isSuccess: boolean;
  isError: boolean;
  data?: PlatformAgentSession;
}): SessionLine {
  if (state.isError) return 'failed';
  if (!state.isSuccess || !state.data) return 'unknown';
  return state.data.empty ? 'empty' : 'kept';
}

/**
 * Показывать ли карточку агентов вообще.
 *
 * Выключенный контур обязан вернуть панель к прежнему виду побайтно, поэтому
 * карточки у него нет. Возможность `agents` из пробы при этом НЕ требуется: проба
 * про агентов честно молчит («не объявлено»), и ждать от неё подтверждения
 * значило бы не показать карточку никогда. Решает манифест типа: у совместимого
 * шлюза агентов нет, и карточка там звала бы чужую ручку (аудит DRV-12). Сервер
 * старее фронта поля не присылает — тогда прежнее поведение.
 */
export function showsAgents(status: Pick<PlatformStatus, 'platform' | 'agents'>): boolean {
  return status.platform.enabled && status.agents !== false;
}

/**
 * Новый идентификатор сессии для разговора.
 *
 * UUID, потому что его требует контур, и генерируется он на нашей стороне: у
 * контура нет ручки «заведи сессию», сессия появляется в момент первого хода с
 * этим идентификатором.
 */
export function newSessionId(): string {
  return crypto.randomUUID();
}
