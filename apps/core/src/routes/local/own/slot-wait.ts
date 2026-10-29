/**
 * Судьба места в очереди слота карты после перезапуска ядра (11 R:PR-04, 01 §Facts F09/F25) —
 * единственный судья класса `slot-wait` (реестр 00 §Decision classes). Решает по фактам, не по
 * возрасту: жив ли по личности (pid + старт) тот, кто место держит, и сколько прошло.
 *
 * - `server` — сервер аренды прошлого ядра: жив → слот держит он; мёртв → слот свободен;
 *   «неизвестно» → слот держится (выдать его второму хуже — две модели в памяти карты) и факт
 *   перечитывается до срока класса `process.alive`; после срока слот всё так же держится, а
 *   ждущие задачи получают точку человека с сервером и причиной — никогда не бесконечное
 *   молчаливое ожидание.
 * - `waiter` — место ждущего, записанное другим ядром: его ядро живо → место чужое, не снимается
 *   ни в каком возрасте (F-88), дольше срока класса — точка человека ждущим за ним, без перехвата;
 *   мертво (или владелец не записан) → место держится окно повторной выдачи, не вернулся за
 *   окно → место снимается с решением в журнал; «неизвестно» → как у сервера: перечитать до
 *   срока, потом точка человека, место НЕ снимается молча.
 * - `lease` — аренда другого ядра (F-88): его ядро живо → аренда его, слот держится ею, сервер не
 *   принимается, не освобождается и не останавливается; дольше срока — точка человека ждущим;
 *   «неизвестно» → перечитать до срока, потом точка человека, руки прочь; мертво (у записи
 *   прежнего вида — мёртв её сервер) → аренда принимается этим ядром обычным путём.
 */

export type SlotWaitSubject = 'server' | 'waiter' | 'lease';

export interface SlotWaitInput {
  subject: SlotWaitSubject;
  /** Чтение `process.alive` владельца места; `absent` — владелец не записан (старый файл). */
  liveness: 'alive' | 'dead' | 'unknown' | 'absent';
  /** Прошло с возвращения места этим ядром (с новой выдачи места — от неё). */
  elapsedMs: number;
  /** Окно повторной выдачи для `waiter`. */
  reissueWindowMs: number;
  /** Срок повторов класса `process.alive` при `unknown`. */
  retryUntilMs: number;
}

export type SlotWaitAction =
  /** Слот / место держится. */
  | 'hold'
  /** Держится, факт перечитывается до `untilMs`. */
  | 'retry'
  /** Слот свободен / место снято. */
  | 'release'
  /** Место или аренда живого чужого ядра: не наше, держится, не снимается. */
  | 'foreign'
  /** Владелец аренды мёртв: аренда принимается этим ядром (сервер, слот, освобождение). */
  | 'adopt'
  /** Срок повторов вышел: держится, ждущие получают точку человека. */
  | 'human-point';

export interface SlotWaitDecision {
  action: SlotWaitAction;
  /** До какого момента (от возвращения) держать без нового решения. */
  untilMs?: number;
  reasons: string[];
}

const WHO: Record<SlotWaitSubject, string> = {
  server: 'model server',
  waiter: 'waiter core',
  lease: 'lease owner core',
};

/** Чем держится непрояснённое после срока: слот, место или чужая аренда. */
const STAYS: Record<SlotWaitSubject, string> = {
  server: 'slot stays held: a second model must not load beside an unproven one',
  waiter: 'place stays: an unproven waiter is never removed silently',
  lease: 'lease stays with its core: never adopted, released or stopped while unproven',
};

export function decideSlotWait(input: SlotWaitInput): SlotWaitDecision {
  const { subject, liveness, elapsedMs, reissueWindowMs, retryUntilMs } = input;
  const who = WHO[subject];
  if (liveness === 'unknown') {
    if (elapsedMs < retryUntilMs)
      return {
        action: 'retry',
        untilMs: retryUntilMs,
        reasons: [`${who} liveness unknown; read again until ${retryUntilMs} ms (process.alive)`],
      };
    return {
      action: 'human-point',
      reasons: [
        `${who} liveness still unknown after ${elapsedMs} ms (process.alive retry-until ${retryUntilMs} ms)`,
        STAYS[subject],
      ],
    };
  }
  if (subject === 'server') {
    return liveness === 'alive'
      ? { action: 'hold', reasons: ['model server alive by identity: slot held by it'] }
      : { action: 'release', reasons: [`model server ${liveness} by identity: slot free`] };
  }
  const what = subject === 'lease' ? 'lease' : 'place';
  // Место и аренда живого чужого ядра не снимаются ни в каком возрасте (F-88); дольше срока — человеку.
  if (liveness === 'alive') {
    if (elapsedMs < retryUntilMs)
      return {
        action: 'foreign',
        untilMs: retryUntilMs,
        reasons: [`${who} alive by identity: its ${what}, never cancelled or taken over`],
      };
    return {
      action: 'human-point',
      reasons: [
        `${who} alive by identity; its ${what} blocks the slot after ${elapsedMs} ms (slot-wait deadline ${retryUntilMs} ms)`,
        `${what} stays: a live core’s ${what} is never cancelled or taken over`,
      ],
    };
  }
  if (subject === 'lease')
    return {
      action: 'adopt',
      reasons: [
        liveness === 'dead'
          ? 'lease owner core dead by identity: this core adopts the lease'
          : 'lease owner not recorded and its model server proven gone: this core adopts the lease',
      ],
    };
  const owner = liveness === 'dead' ? 'waiter core dead by identity' : 'waiter owner not recorded';
  if (elapsedMs < reissueWindowMs)
    return {
      action: 'hold',
      untilMs: reissueWindowMs,
      reasons: [`${owner}; place kept for re-issue until ${reissueWindowMs} ms`],
    };
  return {
    action: 'release',
    reasons: [`${owner}; not re-issued within ${reissueWindowMs} ms: place removed`],
  };
}
