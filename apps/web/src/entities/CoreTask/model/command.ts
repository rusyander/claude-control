import type { CommandDraft } from '@agentdeck/contracts/core/ask-commands';
import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';

/**
 * UUIDv7 (RFC 9562): 48 бит времени в мс, версия 7, вариант 10, остальное — случай. Ядро
 * принимает только его для `cmdId` и загрузки страницы (`page`): номер по времени сортируется
 * в журнале так же, как пришёл.
 */
export function newUuidv7(
  now: number = Date.now(),
  random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Загрузка этой страницы — половина доказательства человека: ядро выдаёт число страницы под
 * этот номер и не примет его от другой загрузки (06 §Authority). Одна на жизнь вкладки.
 */
let pageLoad: string | undefined;
export function pageLoadId(): string {
  pageLoad ??= newUuidv7();
  return pageLoad;
}

// Черновик команды — общий с ботом Telegram (этап 12, P188): одна форма на все карточки вопроса.
export type { CommandDraft } from '@agentdeck/contracts/core/ask-commands';

/** Конверт команды с числом страницы, которое только что выдало ядро. */
export function commandEnvelope(
  draft: CommandDraft,
  nonce: string,
  page: string,
  cmdId: string = newUuidv7(),
): CommandEnvelope {
  return {
    cmdId,
    kind: draft.kind,
    target: { taskId: draft.taskId },
    ...(draft.expectSeq !== undefined ? { expectSeq: draft.expectSeq } : {}),
    fields: draft.fields,
    proof: { nonce, page, ...(draft.signature ? { signature: draft.signature } : {}) },
  };
}
