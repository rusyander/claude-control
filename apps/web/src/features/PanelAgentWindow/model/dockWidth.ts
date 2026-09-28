/**
 * Ширина окна агента, пристёгнутого справа. Человек тянет её ручкой (мышью или
 * стрелками), и она переживает перезагрузку — в localStorage этого браузера:
 * ширина — привычка смотрящего, а не свойство разговора, поэтому одна на все
 * вкладки, а не своя у каждой, как разговор (`windowMemory`).
 *
 * На узком экране (уже 900 px) окно встаёт поверх страницы на всю ширину, и
 * тянуть там нечего — ручки нет, сохранённая ширина не применяется.
 */
export const DOCK_WIDTH_KEY = 'agentdeck:panel-agent-dock-width';

/** Ширина по умолчанию — прежняя постоянная. */
export const DOCK_WIDTH_DEFAULT = 440;

/** Уже — поле ввода с кнопками не помещается в строку. */
export const DOCK_WIDTH_MIN = 360;

/** Шире — страница рядом перестаёт читаться, какой бы ни был экран. */
export const DOCK_WIDTH_CEILING = 960;

/** Сколько страницы остаётся видно слева от окна при любой ширине. */
export const PAGE_MIN_VISIBLE = 480;

/** С этой ширины окна браузера окно агента сдвигает страницу и тянется. */
export const DOCK_WIDE_FROM = 900;

/** Верхняя граница для этого окна браузера; не меньше нижней. */
export function dockWidthMax(viewport: number): number {
  return Math.max(DOCK_WIDTH_MIN, Math.min(DOCK_WIDTH_CEILING, viewport - PAGE_MIN_VISIBLE));
}

export function clampDockWidth(width: number, viewport: number): number {
  return Math.round(Math.min(dockWidthMax(viewport), Math.max(DOCK_WIDTH_MIN, width)));
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

/** Сохранённая ширина; нет её или она битая — по умолчанию. */
export function readDockWidth(storage: ReadableStorage | undefined): number {
  try {
    const value = Number(storage?.getItem(DOCK_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : DOCK_WIDTH_DEFAULT;
  } catch {
    return DOCK_WIDTH_DEFAULT;
  }
}

export function writeDockWidth(storage: WritableStorage | undefined, width: number): void {
  try {
    storage?.setItem(DOCK_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Приватный режим или запрет данных сайта: ширина живёт до перезагрузки.
  }
}

/** Хранилище браузера; сам доступ к нему бросает при запрете данных сайта. */
export function localStore(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
