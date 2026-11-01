import { BACKOFF_MINUTES } from '@agentdeck/contracts/core/publish';

/**
 * Очередь публикаций (05 §After publish, P77): в репозиторий публикует одна единица за раз, по
 * порядку прихода; «опубликовать сейчас» ставит единицу в голову (P96). Форж лёг — ждёт только
 * публикация ЭТОЙ единицы: срок ожидания считается по её собственным строкам `publish.backoff`,
 * остальные единицы идут своим ходом.
 */

interface Waiter {
  unitId: string;
  go(): void;
}

export interface PublishQueue {
  /** Дождаться своей очереди в репозитории; ответ — отпустить очередь. */
  enter(repoKey: string, unitId: string): Promise<() => void>;
  /** «Опубликовать сейчас»: ждущая единица — в голову очереди своего репозитория. */
  promote(unitId: string): void;
  /** Ждущие по репозиторию (для теста и ленты). */
  waiting(repoKey: string): string[];
}

export function createPublishQueue(): PublishQueue {
  const busy = new Set<string>();
  const lines = new Map<string, Waiter[]>();
  const release = (repoKey: string): void => {
    const next = lines.get(repoKey)?.shift();
    if (next) next.go();
    else busy.delete(repoKey);
  };
  return {
    enter(repoKey, unitId) {
      const done = (): void => release(repoKey);
      if (!busy.has(repoKey)) {
        busy.add(repoKey);
        return Promise.resolve(done);
      }
      return new Promise((resolve) => {
        const line = lines.get(repoKey) ?? [];
        line.push({ unitId, go: () => resolve(done) });
        lines.set(repoKey, line);
      });
    },
    promote(unitId) {
      for (const line of lines.values()) {
        const at = line.findIndex((w) => w.unitId === unitId);
        if (at > 0) line.unshift(...line.splice(at, 1));
      }
    },
    waiting(repoKey) {
      return (lines.get(repoKey) ?? []).map((w) => w.unitId);
    },
  };
}

/** Срок n-го ожидания форжа: 1, 2, 5, 10, 30 минут, дальше — 30 (05:85). */
export function backoffMs(attempt: number): number {
  const at = Math.min(Math.max(attempt, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[at]! * 60_000;
}

/**
 * Номер следующего ожидания ЭТОЙ единицы: прошлое ожидание после последней удачи — следующий,
 * иначе первый. Вход — строки этой единицы, никогда общий счёт задачи.
 */
export function nextBackoffAttempt(
  prev: { attempt: number; seq: number } | null,
  lastSuccessSeq: number,
): number {
  return prev && prev.seq > lastSuccessSeq ? prev.attempt + 1 : 1;
}
