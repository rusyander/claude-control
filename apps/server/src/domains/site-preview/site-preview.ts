/**
 * Окно сайта в чате (этап 12, D20): прокси панели над dev-сервером, который запустила она сама,
 * со вставленным скриптом выбора элемента. Фасад раздела; маршруты — `routes/site-preview`.
 */
export { SitePreviewHub } from './hub.ts';
export { startSiteProxy, SITE_PROXY_HOST } from './proxy.ts';
export { injectPickTag, isHtmlResponse, PICK_TAG } from './inject.ts';
export { pickScript } from './pick-script.ts';
export type {
  SiteRunnerSource,
  SiteProxy,
  SitePreviewRefusal,
  SiteOpenResult,
  SitePickResult,
} from './site-preview.types.ts';
