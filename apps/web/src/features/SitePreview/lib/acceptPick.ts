import {
  PICK_CANCEL_TYPE,
  pickPayloadSchema,
  type PickPayload,
  type SitePreview,
} from '@agentdeck/contracts/site-preview';
import type { FrameMessage } from './acceptPick.types';

/** Происхождение адреса прокси: только с него окно сайта вправе писать родителю. */
function originOf(url: string): string | undefined {
  try {
    // Адрес прокси сервер отдаёт полным (`http://127.0.0.1:<порт>/`): база не нужна.
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Сообщение пришло от ЭТОГО iframe и с адреса ЭТОГО прокси — иначе его не читают вовсе. */
function fromFrame(message: FrameMessage, frame: Window | null, preview: SitePreview): boolean {
  if (!frame || message.source !== frame) return false;
  const origin = originOf(preview.url);
  return origin !== undefined && message.origin === origin;
}

/**
 * Выбор элемента, который окно чата принимает (P174): от своего iframe, со своего прокси, по
 * схеме и со своим `nonce`. Любое иное сообщение — чужая страница, вкладка или старое окно —
 * отвергнуто: подделать выбор и подсунуть агенту текст снаружи нельзя.
 */
export function acceptPick(
  message: FrameMessage,
  frame: Window | null,
  preview: SitePreview,
): PickPayload | undefined {
  if (!fromFrame(message, frame, preview)) return undefined;
  const parsed = pickPayloadSchema.safeParse(message.data);
  if (!parsed.success || parsed.data.nonce !== preview.nonce) return undefined;
  return parsed.data;
}

/** Человек снял выбор клавишей Escape внутри сайта — те же проверки источника и `nonce`. */
export function isPickCancel(
  message: FrameMessage,
  frame: Window | null,
  preview: SitePreview,
): boolean {
  if (!fromFrame(message, frame, preview)) return false;
  const data = message.data as { type?: unknown; nonce?: unknown } | null;
  return (
    typeof data === 'object' &&
    data !== null &&
    data.type === PICK_CANCEL_TYPE &&
    data.nonce === preview.nonce
  );
}
