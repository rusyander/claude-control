import { type PanelAgentPageContext } from '@agentdeck/contracts/panel-agent';

/**
 * Агент панели на телефоне (А8): чистая часть — что сказать человеку. Разговор,
 * карточки и след — те же маршруты, что у окна панели; своего поведения у
 * телефона нет, только другой экран.
 */

/**
 * Где человек: страниц панели у телефона нет, и притворяться ими нельзя —
 * `where_am_i` вернул бы модели чужой раздел. Маршрут вне списка разделов
 * панели, заголовок прямо говорит модели, что `open_page` откроется на
 * компьютере, а не здесь. Английский: его читает модель.
 */
export const PHONE_ROUTE = 'phone';

export function phoneContext(projectPath?: string): PanelAgentPageContext {
  return {
    route: PHONE_ROUTE,
    title: 'Phone app (no panel pages here; open_page shows the page on the desktop panel)',
    ...(projectPath ? { projectPath } : {}),
  };
}
