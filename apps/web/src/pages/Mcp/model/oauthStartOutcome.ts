import type { StartOAuthResult } from '@entities/McpServer';

/**
 * Что делать с ответом на старт входа — с оглядкой на то, открылось ли окно.
 *
 * Окно авторизации открывается синхронно по клику, до запроса, поэтому его
 * может срезать блокировщик всплывающих окон. Раньше этот случай не проверялся:
 * ветка «есть адрес И есть окно» просто не срабатывала, мутация завершалась
 * успехом (значит, и общий тост об ошибке молчал), а на сервере оставался
 * заведённый и никогда не завершаемый вход. Со стороны человека — крутилка
 * погасла, и ничего не произошло.
 *
 * Поэтому решение вынесено отдельно: адрес есть всегда, разница лишь в том,
 * открыть его самим или показать человеку ссылку. Отсутствие адреса — тоже
 * исход, а не молчание.
 */
export type OAuthStartOutcome =
  /** Токен уже есть — входить не нужно. */
  | { kind: 'authorized' }
  /** Окно живо: ведём его на адрес авторизации сами. */
  | { kind: 'popup'; url: string }
  /** Окна нет (блокировщик) — адрес показываем ссылкой. */
  | { kind: 'manual'; url: string }
  /** Сервер сказал «нужен вход», но адреса не дал. */
  | { kind: 'noUrl' };

export function oauthStartOutcome(result: StartOAuthResult, hasPopup: boolean): OAuthStartOutcome {
  if (result.status === 'authorized') return { kind: 'authorized' };
  if (!result.authorizationUrl) return { kind: 'noUrl' };

  return hasPopup
    ? { kind: 'popup', url: result.authorizationUrl }
    : { kind: 'manual', url: result.authorizationUrl };
}
