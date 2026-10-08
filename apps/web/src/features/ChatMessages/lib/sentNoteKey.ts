/** Подпись под отправленным ответом: дошёл, ждёт очереди или только что ушёл. */
export function sentNoteKey(
  isDelivered: boolean | undefined,
  isQueued: boolean,
  hasTarget: boolean,
) {
  if (isDelivered) return hasTarget ? 'chat.questionDeliveredToNote' : 'chat.questionDeliveredNote';
  if (isQueued) return hasTarget ? 'chat.questionQueuedToNote' : 'chat.questionQueuedNote';
  return hasTarget ? 'chat.questionSentToNote' : 'chat.questionSentNote';
}
