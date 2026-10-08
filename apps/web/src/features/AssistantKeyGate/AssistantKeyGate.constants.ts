import type { GateKind } from './model/gateKind';

/** Подпись модалки по виду гейта; `hidden` модалку не показывает вовсе. */
export const DESCRIPTION_KEY: Record<Exclude<GateKind, 'hidden'>, string> = {
  key: 'assistantKey.description',
  cliOnly: 'assistantKey.cliOnly',
  unsupported: 'assistantKey.unsupported',
};
