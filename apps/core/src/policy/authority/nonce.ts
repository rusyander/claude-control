import { randomBytes } from 'node:crypto';

/**
 * Одноразовые числа человеческого доказательства (06 §Authority (a)): ядро само выдаёт число
 * на загрузку страницы (`GET /v1/nonce?page=<uuidv7>`) и само его проверяет — прокси только
 * несёт. Число одноразовое (повтор — `invalid`), живёт 10 минут и годно только для той
 * загрузки, для которой выдано (число чужой загрузки — `invalid`, корпус P41).
 * Хранятся в памяти: перезапуск ядра гасит все выданные числа — страница берёт новое.
 */

export const NONCE_TTL_MS = 10 * 60_000;
/**
 * Предел живых чисел. Сверх него уходит самое НОВОЕ из прежних, не старое (F-109): поток чужих
 * выдач вытесняет сам себя, а не живое число открытой страницы; только что выданное живо всегда.
 */
export const NONCE_LIMIT = 10_000;
/** Живых чисел на одну загрузку страницы: сверх — старые этой же страницы уходят первыми. */
export const NONCES_PER_PAGE = 8;

export type NonceCheck = 'absent' | 'valid' | 'invalid';

export interface NonceStore {
  mint(page: string): { nonce: string; expiresAt: number };
  /** Проверка с погашением: годное число гасится этим же вызовом. */
  consume(nonce: string | undefined, page: string | undefined): NonceCheck;
  readonly size: number;
}

export function createNonceStore(now: () => number = Date.now): NonceStore {
  const live = new Map<string, { page: string; expiresAt: number }>();
  const sweep = (page: string): void => {
    const at = now();
    const ofPage: string[] = [];
    for (const [nonce, entry] of live) {
      if (entry.expiresAt <= at) live.delete(nonce);
      else if (entry.page === page) ofPage.push(nonce);
    }
    while (ofPage.length >= NONCES_PER_PAGE) live.delete(ofPage.shift() as string);
    if (live.size < NONCE_LIMIT) return;
    // Полно: уходит самое новое из прежних — живые числа открытых страниц не вытесняются.
    let newest: string | undefined;
    for (const nonce of live.keys()) newest = nonce;
    if (newest !== undefined) live.delete(newest);
  };
  return {
    mint(page) {
      sweep(page);
      const nonce = randomBytes(24).toString('base64url');
      const expiresAt = now() + NONCE_TTL_MS;
      live.set(nonce, { page, expiresAt });
      return { nonce, expiresAt };
    },
    consume(nonce, page) {
      if (nonce === undefined) return 'absent';
      const entry = live.get(nonce);
      if (!entry) return 'invalid';
      // Гасим и чужое: число, показанное не той странице, уже скомпрометировано.
      live.delete(nonce);
      if (entry.expiresAt <= now()) return 'invalid';
      if (page === undefined || entry.page !== page) return 'invalid';
      return 'valid';
    },
    get size() {
      return live.size;
    },
  };
}
