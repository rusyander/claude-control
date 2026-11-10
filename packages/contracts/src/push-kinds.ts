/**
 * Виды push на телефон (этап 12, P188): только то, что ЖДЁТ человека — разрешение и вопрос.
 * «Готово» и «ошибка» в push не уходят (их видно на доске и в чате); `RemoteNotifyKind` из
 * `remote.ts` шире намеренно — его читают уведомления прогона и Telegram, где «готово» остаётся.
 * Модуль без импортов: его читают сервер, веб и приложение (`mobile:contracts`).
 */

export const REMOTE_PUSH_KINDS = ['permission', 'question'] as const;
export type RemotePushKind = (typeof REMOTE_PUSH_KINDS)[number];

/** Уходит ли уведомление этого вида push-ем: да — только ждущие человека виды. */
export function isRemotePushKind(kind: string): kind is RemotePushKind {
  return (REMOTE_PUSH_KINDS as readonly string[]).includes(kind);
}
