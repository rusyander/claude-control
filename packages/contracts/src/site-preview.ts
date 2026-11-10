import { z } from 'zod';

/**
 * Окно сайта в чате и выбор элемента (этап 12, D27, P189). Сайт проекта панель открывает в
 * iframe через свой прокси; скрипт выбора, вставленный прокси, шлёт родителю `PickPayload`
 * через `postMessage`. Родитель принимает сообщение только со своим `nonce` и только от окна
 * этого iframe — чужая страница выбор не подделает.
 */

/** Открыть окно сайта: `path` — ключ реестра запусков (`project-runner`), не адрес. */
export const sitePreviewOpenBodySchema = z.strictObject({
  path: z.string().min(1).max(1000),
});
export type SitePreviewOpenBody = z.infer<typeof sitePreviewOpenBodySchema>;

/** Открытое окно: адрес прокси панели и одноразовый `nonce`, которым подписан каждый выбор. */
export const sitePreviewSchema = z.strictObject({
  siteId: z.string().min(1).max(200),
  url: z.string().min(1).max(2000),
  nonce: z.string().min(16).max(200),
});
export type SitePreview = z.infer<typeof sitePreviewSchema>;

export const PICK_MESSAGE_TYPE = 'agentdeck:pick';
/** Родитель → скрипт выбора: включить или снять режим выбора (`{type, nonce, on}`). */
export const PICK_MODE_TYPE = 'agentdeck:pick-mode';
/** Скрипт выбора → родитель: человек снял выбор клавишей Escape (`{type, nonce}`). */
export const PICK_CANCEL_TYPE = 'agentdeck:pick-cancel';
/** Адрес скрипта выбора на прокси: путь зарезервирован, сайту не передаётся. */
export const PICK_SCRIPT_PATH = '/__agentdeck/pick.js';
/** Предел видимого текста выбранного элемента: суть, а не страница. */
export const PICK_TEXT_MAX = 300;
/** Предел разметки выбранного элемента: дальше — обрезано скриптом выбора. */
export const PICK_HTML_MAX = 4096;

const finite = z.number().finite();

/** Выбранный элемент: что вставить в ввод чата (селектор, тег, текст, разметка, место, адрес). */
export const pickPayloadSchema = z.strictObject({
  type: z.literal(PICK_MESSAGE_TYPE),
  nonce: z.string().min(16).max(200),
  selector: z.string().min(1).max(2000),
  tag: z.string().min(1).max(100),
  text: z.string().max(PICK_TEXT_MAX),
  outerHTML: z.string().max(PICK_HTML_MAX),
  rect: z.strictObject({ x: finite, y: finite, width: finite, height: finite }),
  url: z.string().min(1).max(2000),
});
export type PickPayload = z.infer<typeof pickPayloadSchema>;
