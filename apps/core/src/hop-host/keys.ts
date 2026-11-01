import type { KeyRef } from '@agentdeck/contracts/core/routes';
import { isKeysError } from '@agentdeck/keys/errors';
import { readKeyStrict } from '@agentdeck/keys/provider-keys';
import type { KeyRead, KeySource } from './host.types.ts';

/**
 * Откуда звено берёт настоящий ключ (G5, P112). Ядро держит только ссылку; значение читается
 * здесь на КАЖДОМ запросе — смена ключа в панели видна сразу, и значение не живёт в памяти
 * дольше одного запроса и не пишется никуда, кроме заголовка запроса наверх.
 *
 * - `panel-store` — хранилище панели (`@agentdeck/keys`: тот же файл, та же криптография).
 *   Непрочитанное хранилище — `unknown` с кодом, не «ключа нет»: иначе запрос ушёл бы без ключа.
 * - `env` — переменная окружения ХОСТА. Хост запускается с окружением помощника (без ключей),
 *   поэтому такая ссылка разрешается только там, где хост получил переменную от системы
 *   (названный остаток 11:71).
 * - `hop-injected` — наверху другое звено, которое опознаёт сеанс той же заглушкой: её и
 *   пересылаем (`forward`), своего ключа нет.
 */
export function createKeySource(panelAppData: string | undefined): KeySource {
  return {
    resolve(ref: KeyRef): KeyRead {
      if (ref.kind === 'env') {
        const value = process.env[ref.name];
        return value ? { value } : { absent: true };
      }
      if (ref.kind === 'hop-injected') return { absent: true };
      if (!panelAppData) return { unknown: 'panel app-data directory not given to the hop host' };
      try {
        const value = readKeyStrict(panelAppData, ref.name);
        return value === undefined ? { absent: true } : { value };
      } catch (error) {
        return { unknown: isKeysError(error) ? error.code : 'key store unreadable' };
      }
    },
  };
}
