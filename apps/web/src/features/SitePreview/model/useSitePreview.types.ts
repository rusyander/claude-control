import type { PickPayload, SitePreview } from '@agentdeck/contracts/site-preview';
import type { ProjectRunnerView } from '@agentdeck/contracts';

export interface SitePreviewState {
  /** Работающая цель проекта с адресом — есть она, есть и кнопка «Открыть сайт». */
  target?: ProjectRunnerView;
  /** Открытое окно: прокси панели и `nonce`. Пусто — окно закрыто. */
  preview?: SitePreview;
  /** Имя открытой цели — заголовок окна и подпись iframe. */
  name?: string;
  /** Адрес самого dev-сервера — «Открыть в браузере» ведёт туда, а не на прокси. */
  siteUrl?: string;
  isOpening: boolean;
  open: () => Promise<boolean>;
  close: () => void;
  /** Принятый окном выбор — на проверку и маскировку серверу; отказ — пусто и тост. */
  pick: (raw: PickPayload) => Promise<PickPayload | undefined>;
}
