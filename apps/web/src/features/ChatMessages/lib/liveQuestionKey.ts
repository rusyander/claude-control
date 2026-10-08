import { questionKey } from './questionKey';

/**
 * Имя ЖИВОГО вопроса — из потока прогона.
 *
 * Id вызова уникален сам по себе, и в имя разговор не входит нарочно: один
 * разговор известен панели под двумя именами — черновым `new-…` до первого
 * ответа сервера и sessionId после F5. Войди разговор в имя, ответ, данный под
 * одним, после перезагрузки не находился бы под другим, и карточка
 * воскресала бы ровно так, как до починки. Без id (старые прогоны) остаётся
 * тело вызова, и тут разговор нужен: одинаковый текст в двух разговорах — два
 * разных вопроса.
 */
export function liveQuestionKey(scope: string, toolUseId?: string, input?: string): string {
  return toolUseId ? questionKey('call', toolUseId) : questionKey(scope, undefined, input);
}
