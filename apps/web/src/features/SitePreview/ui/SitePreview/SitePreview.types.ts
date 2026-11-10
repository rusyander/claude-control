import type { PickPayload, SitePreview } from '@agentdeck/contracts/site-preview';

export interface SitePreviewProps {
  /** Открытое окно сайта: адрес прокси панели и `nonce`, которым подписан каждый выбор. */
  preview: SitePreview;
  /** Выбор элемента прошёл проверку `nonce` и окна-источника — его описание идёт в ввод чата. */
  onPick: (pick: PickPayload) => void;
  /** Закрыть окно сайта. */
  onClose: () => void;
  /** Имя цели запуска — заголовок окна и подпись iframe. */
  name?: string;
  /** Адрес самого dev-сервера: «Открыть в браузере». Пусто — кнопки нет. */
  siteUrl?: string;
}
