import type { CSSProperties } from 'react';
import { placePopover } from '../model/placeBeside';

/** Зазор между краем боковой панели и окном, px. */
export const POPOVER_GAP = 8;

/** Окно не прижимается к краям экрана вплотную, px. */
export const VIEWPORT_MARGIN = 16;

/** Высота окна, пока его ещё не нарисовали: первый кадр до замера. */
export const POPOVER_HEIGHT_GUESS = 260;

/** Ширина окна до замера — как в стилях (`.popover`). */
export const POPOVER_WIDTH_GUESS = 320;

/** Окно у видимого правого края строки; целиком в экране (`placePopover`). */
export function placeBeside(
  trigger: HTMLElement | null,
  popover: HTMLElement | null,
): CSSProperties {
  const rect = trigger?.getBoundingClientRect();
  if (!rect) return {};
  const clip = trigger?.closest('nav')?.getBoundingClientRect();
  return placePopover({
    anchor: rect,
    clip,
    width: popover?.offsetWidth || POPOVER_WIDTH_GUESS,
    height: popover?.offsetHeight || POPOVER_HEIGHT_GUESS,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    gap: POPOVER_GAP,
    margin: VIEWPORT_MARGIN,
  });
}
