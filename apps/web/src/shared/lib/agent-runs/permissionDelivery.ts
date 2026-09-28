/**
 * Дошло ли решение по правам до брокера на сервере.
 *
 * Карточка с кнопками «Разрешить»/«Запретить» убирается с экрана сразу, не
 * дожидаясь ответа, — иначе клик выглядит залипшим. Но ответ бывает и отказом:
 * сервер возвращает `{ok:false}`, когда висящего запроса под этим ключом уже
 * нет (разговор остановлен или перезапущен). Раньше и он, и сетевая ошибка
 * молча проглатывались: карточка исчезала, чат выглядел живым, а агент
 * оставался заблокированным до собственного таймаута — и повторить решение
 * человеку было незачем, он ведь «уже ответил».
 *
 * Отдельно — умерший запрос (410 `permission_expired`): CLI оборвал вызов по
 * своему сроку, и «Разрешить» не запустит ничего. Это не обрыв связи, и
 * говорить «нет связи с сервером» здесь было бы неправдой.
 *
 * Незнакомая форма ответа считается доставкой: пугать сообщением из-за
 * посредника, переписавшего тело, хуже, чем промолчать.
 */
export function permissionDeliveryProblem(
  result: { ok?: unknown } | undefined,
  error?: unknown,
): 'chat.permissionUnreachable' | 'chat.permissionLost' | 'chat.permissionExpired' | undefined {
  if (error !== undefined)
    return isExpiredRefusal(error) ? 'chat.permissionExpired' : 'chat.permissionUnreachable';
  if (result?.ok === false) return 'chat.permissionLost';
  return undefined;
}

/** Отказ сервера «запрос уже истёк» — по коду, а не по тексту. */
function isExpiredRefusal(error: unknown): boolean {
  const response = (error as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  if (!response) return false;
  const code = (response.data as { code?: unknown } | null | undefined)?.code;
  return code === 'permission_expired' || response.status === 410;
}
