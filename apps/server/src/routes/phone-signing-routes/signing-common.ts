import { join } from 'node:path';
import type { FastifyReply } from 'fastify';
import type { SignatureRefusal } from '@agentdeck/contracts/phone-signing';
import { panelHomeDir } from '../../lib/brand.mjs';
import { PhoneSigningStore } from '../../domains/phone-signing/store.ts';

/** Файл режима подписи — рядом с токеном API (`domains/phone-signing/store.ts`). */
export function phoneSigningPath(): string {
  return join(panelHomeDir(), 'phone-signing.json');
}

/**
 * Хранилище на путь: каталог панели на стенде свой, и путь спрашивается при
 * каждом запросе, а не один раз при сборке.
 */
const stores = new Map<string, PhoneSigningStore>();

export function phoneSigningStore(path: string = phoneSigningPath()): PhoneSigningStore {
  let store = stores.get(path);
  if (!store) {
    store = new PhoneSigningStore(path);
    stores.set(path, store);
  }
  return store;
}

const REFUSALS: Record<SignatureRefusal, string> = {
  required:
    'Решение не принято: включён режим «решения только с подписью телефона», а запрос пришёл без подписи. Ответьте с телефона, к которому привязан ключ (Настройки → Подпись решений), — там решение подписывается само. Запретить можно откуда угодно.',
  lever:
    'Изменение не принято: включён режим «решения только с подписью телефона», а оно ослабляет права всех будущих решений. Выключите подпись на телефоне (Настройки → Подпись решений), сделайте изменение и включите её снова.',
  invalid:
    'Решение не принято: подпись телефона не сошлась — ключ не привязан к этой панели или запрос изменён по дороге.',
  revoked:
    'Решение не принято: ключ этого телефона отозван в панели. Привяжите телефон заново, когда режим подписи выключен.',
  stale:
    'Решение не принято: часы телефона и компьютера расходятся больше чем на 5 минут. Проверьте время на обоих и ответьте снова.',
  replayed:
    'Решение не принято: эта подпись уже использована. Повтор того же запроса не принимается — ответьте заново.',
  'no-device':
    'Решение не принято: режим подписи включён, а привязанных телефонов не осталось. Чтобы выключить режим без телефона, удалите на этом компьютере файл {{path}}.',
};

/** 403 с кодом текста: телефон и окно переводят его своим словарём. */
export function refuseSignature(
  reply: FastifyReply,
  refusal: SignatureRefusal,
  storePath: string = phoneSigningPath(),
) {
  const params = refusal === 'no-device' ? { path: storePath } : undefined;
  const message = params ? REFUSALS[refusal].replace('{{path}}', params.path) : REFUSALS[refusal];
  return reply.code(403).send({
    code: `decision_signature_${refusal.replace('-', '_')}`,
    message,
    messageCode: `decision-signature-${refusal}`,
    ...(params ? { params } : {}),
  });
}
