/**
 * Прогон, к которому надо перейти по ссылке `?run=` — или ничего.
 *
 * Ссылка из истории кейса раскрывает запись и доводит до неё экран ОДИН раз,
 * когда список уже пришёл. Список перечитывается (опрос идущего прогона,
 * возврат фокуса), и раньше каждое перечитывание снова раскрывало запись по
 * ссылке и крутило к ней экран — человека выдёргивало из записи, которую он
 * открыл сам. `followed` — ссылка, по которой уже прошли.
 */
export function linkedRunToFollow(
  openRunId: string | undefined,
  followed: string,
  hasData: boolean,
): string | undefined {
  if (!openRunId || !hasData || openRunId === followed) return undefined;
  return openRunId;
}
