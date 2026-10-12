/**
 * Ответ сервера на «чистую сессию» — общий для Claude и чужого CLI. `requested`:
 * файл-опора не свежа, просьбу её обновить экран отправляет обычным сообщением.
 * `started`: продолжение уже заведено, экран переходит в него.
 */
export type RestartReply<Started> =
  { mode: 'requested'; prompt: string } | ({ mode: 'started' } & Started);

export async function applyRestart<Started>(
  reply: RestartReply<Started>,
  act: { send: (prompt: string) => Promise<boolean>; open: (started: Started) => void },
  failed: string,
): Promise<void> {
  if (reply.mode === 'requested') {
    // Отказ отправки — ошибка кнопки: иначе подтверждение закроется, а просьба
    // так и не уйдёт.
    if (!(await act.send(reply.prompt))) throw new Error(failed);
    return;
  }
  act.open(reply);
}
