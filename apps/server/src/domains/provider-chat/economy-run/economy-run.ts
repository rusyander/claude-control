import type { EconomyChannel } from '../../../providers/types/types.ts';
import { codexEconomyEnv } from './codex.ts';
import { continueEconomyEnv } from './continue.ts';
import { geminiEconomyEnv } from './gemini.ts';
import { gooseEconomyEnv } from './goose.ts';
import { qwenEconomyEnv } from './qwen.ts';
import type { EconomyRunChannel, EconomyRunInput } from './economy-run.types.ts';

export type { EconomyRunChannel, EconomyRunInput } from './economy-run.types.ts';

/**
 * Диспетчер рычагов экономии групп на один прогон чужого CLI.
 *
 * Рычаги страницы «Настройки → Группы» общие, а доходят до каждого CLI своим
 * путём, и ни один путь не трогает конфиг человека: у Codex — ключи `-c` запуска,
 * у Qwen Code — слой системных настроек на прогон, у Goose и Continue —
 * переменные окружения. У Gemini канал пуст и каталог его не объявляет: файл
 * настроек на прогон CLI принимает только от администратора (`gemini.ts`).
 * Канал провайдера объявлен в его каталоге
 * (`groupEconomy.channel`); у Claude канала нет — его рычаги собирает
 * `group-profile.ts` его собственными ключами, и сюда он не попадает никогда.
 *
 * Канала нет — `undefined`: прогон идёт как шёл.
 */
const CHANNELS: Record<EconomyChannel, EconomyRunChannel> = {
  codex: codexEconomyEnv,
  qwen: qwenEconomyEnv,
  gemini: geminiEconomyEnv,
  goose: gooseEconomyEnv,
  continue: continueEconomyEnv,
};

export function economyRunEnv(
  channel: EconomyChannel | undefined,
  input: EconomyRunInput,
): Record<string, string> | undefined {
  if (!channel) return undefined;
  const env = CHANNELS[channel](input);
  return env && Object.keys(env).length > 0 ? env : undefined;
}
