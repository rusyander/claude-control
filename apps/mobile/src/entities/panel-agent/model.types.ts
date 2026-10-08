import type { PanelTextParams } from '@agentdeck/contracts/panel-agent';

/** Текст по коду словарём телефона; без кода — русский запасной текст сервера. */
export type CardText = (
  code: string | undefined,
  params: PanelTextParams | undefined,
  fallback: string,
) => string;
