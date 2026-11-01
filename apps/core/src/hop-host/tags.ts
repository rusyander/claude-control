import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  hopRegisterSpecSchema,
  type HopRegistration,
  type HopTag,
} from '@agentdeck/contracts/core/hops';
import { readJsonFile, writeJsonFile } from './gateway/json-file.ts';
import type { TagEntry } from './host.types.ts';

/**
 * Сеансы, которые знает звено (P112, P122). Сеанс опознаётся заглушкой ключа, которую ядро
 * положило в его окружение: CLI шлёт её в `x-api-key`/`Authorization`, как шлёт любой ключ, и
 * другого канала от чужого CLI к звену нет. На диске заглушки нет — только её sha256: файл меток
 * не даёт войти в звено от имени сеанса и тем более не несёт настоящий ключ (его звено читает
 * по ссылке на каждом запросе и нигде не хранит).
 *
 * Файл меток переживает перезапуск хоста: CLI посреди работы продолжает слать ту же заглушку.
 */

const PLACEHOLDER_PREFIX = 'adk-hop-';

interface TagsFile {
  v: 1;
  tags: TagEntry[];
}

export function hashPlaceholder(placeholder: string): string {
  return createHash('sha256').update(placeholder).digest('hex');
}

/** Заглушка ключа из заголовков запроса: `x-api-key` или `Authorization: Bearer …`. */
export function credentialOf(request: Pick<IncomingMessage, 'headers'>): string | undefined {
  const apiKey = request.headers['x-api-key'];
  const direct = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  if (direct?.trim()) return direct.trim();
  const auth = request.headers.authorization;
  const match = /^Bearer\s+(.+)$/i.exec((Array.isArray(auth) ? auth[0] : auth) ?? '');
  return match?.[1]?.trim() || undefined;
}

export class TagRegistry {
  readonly #path: string;
  readonly #byHash = new Map<string, TagEntry>();
  readonly #byTag = new Map<HopTag, TagEntry>();
  /** Значения ключей `env` по метке (`register.sessionKey`) — никогда в `#persist`. */
  readonly #keys = new Map<HopTag, string>();

  constructor(path: string) {
    this.#path = path;
    let file: TagsFile;
    try {
      file = readJsonFile<TagsFile>(path, { v: 1, tags: [] });
    } catch {
      // Битый файл меток не роняет хост: сеансы перерегистрируются при следующем запуске CLI,
      // а до того запрос с неизвестной заглушкой получает внятный отказ, не чужой сеанс.
      file = { v: 1, tags: [] };
    }
    for (const entry of Array.isArray(file.tags) ? file.tags : []) {
      // Строка прежнего хоста (до полей драйвера, цены, правил) получает значения по умолчанию
      // той же схемой, что и регистрация; непригодная к ней не оживает чужим сеансом.
      const spec = hopRegisterSpecSchema.safeParse(entry?.spec);
      if (spec.success && typeof entry.placeholderHash === 'string')
        this.#index({ ...entry, spec: spec.data });
    }
  }

  #index(entry: TagEntry): void {
    const previous = this.#byTag.get(entry.spec.tag);
    if (previous) this.#byHash.delete(previous.placeholderHash);
    this.#byTag.set(entry.spec.tag, entry);
    this.#byHash.set(entry.placeholderHash, entry);
  }

  #persist(): void {
    writeJsonFile(this.#path, { v: 1, tags: [...this.#byTag.values()] } satisfies TagsFile);
  }

  /**
   * Регистрация сеанса: новая заглушка на каждый вызов. Повторная регистрация той же метки
   * (перезапуск сеанса) выдаёт новую заглушку и гасит прежнюю — старый процесс CLI, если он
   * ещё жив, больше не ходит от имени сеанса.
   */
  register(spec: HopRegistration, now: number, sessionKey?: string): string {
    const placeholder = `${PLACEHOLDER_PREFIX}${randomBytes(24).toString('base64url')}`;
    this.#index({ spec, placeholderHash: hashPlaceholder(placeholder), registeredAt: now });
    // Ключ сеанса — только в памяти: файл меток его не видит, перезапуск хоста его теряет
    // (сеанс получит названный отказ «ключ не прочитан», а не чужой ключ из окружения).
    if (sessionKey) this.#keys.set(spec.tag, sessionKey);
    else this.#keys.delete(spec.tag);
    this.#persist();
    return placeholder;
  }

  /** Ключ `env`, переданный ядром при регистрации этой метки; нет — ключа сеанса нет. */
  sessionKey(tag: HopTag): string | undefined {
    return this.#keys.get(tag);
  }

  unregister(tag: HopTag): boolean {
    const entry = this.#byTag.get(tag);
    this.#keys.delete(tag);
    if (!entry) return false;
    this.#byTag.delete(tag);
    this.#byHash.delete(entry.placeholderHash);
    this.#persist();
    return true;
  }

  /** Сеанс по заглушке из запроса; сравнение хэшей — постоянного времени. */
  lookup(credential: string | undefined): TagEntry | undefined {
    if (!credential) return undefined;
    const hash = hashPlaceholder(credential);
    const entry = this.#byHash.get(hash);
    if (!entry) return undefined;
    const same = timingSafeEqual(Buffer.from(entry.placeholderHash), Buffer.from(hash));
    return same ? entry : undefined;
  }

  byTag(tag: HopTag): TagEntry | undefined {
    return this.#byTag.get(tag);
  }

  tags(): HopTag[] {
    return [...this.#byTag.keys()];
  }
}
