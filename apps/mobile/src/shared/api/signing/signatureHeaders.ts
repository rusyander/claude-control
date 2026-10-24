import { SIGNATURE_HEADER } from '@agentdeck/contracts/phone-signing';
import { activePanel, currentConnection } from '../connection';
import { freshNonce, loadKey } from './keyStore';
import { signatureHeader, signingTarget, wireBody, type PhoneKey } from './signing';

/**
 * Подпись к запросу, если он — разрешающее решение и у телефона есть ключ для
 * выбранного компьютера. Подписывается всегда, а не только при включённом
 * режиме: телефон не знает наверняка, включён ли он сейчас, а сервер при
 * выключенном режиме подпись просто не читает. Ключа нет — заголовка нет, и
 * решает сервер (выключено — пройдёт, включено — отказ с причиной).
 */

export interface SignatureDeps {
  machineId: () => string;
  key: (machineId: string) => Promise<PhoneKey | undefined>;
  nonce: () => string;
  now: () => number;
}

const DEFAULTS: SignatureDeps = {
  machineId: () => activePanel(currentConnection())?.machineId ?? '',
  key: loadKey,
  nonce: freshNonce,
  now: Date.now,
};

export async function signatureHeaders(
  method: string,
  path: string,
  body: unknown,
  deps: SignatureDeps = DEFAULTS,
): Promise<Record<string, string>> {
  const wire = wireBody(body);
  const target = signingTarget(method, path, wire);
  if (!target) return {};
  const panel = deps.machineId();
  if (!panel) return {};
  const key = await deps.key(panel);
  if (!key) return {};
  return {
    [SIGNATURE_HEADER]: signatureHeader({
      key,
      panel,
      target,
      body: wire,
      nonce: deps.nonce(),
      time: deps.now(),
    }),
  };
}
