import type { LocalMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import { coded } from '../../lib/server-text.ts';

/**
 * Ошибка раздела с кодом текста: русская строка остаётся запасной, а
 * английский интерфейс переводит код своим словарём.
 */
export function localError(
  code: LocalMessageCode,
  text: string,
  params?: ServerMessageParams,
): Error {
  return coded(new Error(text), code, params);
}
