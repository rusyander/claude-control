import type { AgentAnomalies, AgentStep } from '@agentdeck/contracts';

/**
 * Странности хода агента, видимые глазом: отказы хуков, вызовы с ошибкой,
 * повторные чтения одного файла и результаты длиннее 10 000 символов — то, на
 * чём агент тратит ходы и контекст. Считается по всему транскрипту, не по окну.
 */

/** Результат длиннее этого — «большой»: столько символов уходит в контекст разом. */
export const LARGE_RESULT_CHARS = 10_000;

/** Причина отказа хука одной строкой — не больше стольких символов. */
const DENIAL_LIMIT = 600;

/** CLI пишет отказ хука результатом вызова: «PreToolUse:Bash hook error: …». */
const HOOK_DENIAL = /^[A-Za-z]+:\S+ hook error:\s*([\s\S]*)$/u;

/** Причина отказа хука по тексту результата; не отказ — `undefined`. */
export function hookDenialReason(text: string): string | undefined {
  const match = HOOK_DENIAL.exec(text.trim());
  if (!match) return undefined;
  const reason = (match[1] ?? '').trim();
  const clipped = reason.length > DENIAL_LIMIT ? `${reason.slice(0, DENIAL_LIMIT)}…` : reason;
  return clipped || text.trim().slice(0, DENIAL_LIMIT);
}

export class AnomalyTally {
  private denials = 0;
  private errors = 0;
  private largeResults = 0;
  private readonly reads = new Map<string, number>();

  /** Вызов `Read` файла `path`. */
  read(path: string): void {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
  }

  /** Вызов получил результат: отказ хука, ошибка, размер. */
  result(step: AgentStep): void {
    if (step.denial !== undefined) this.denials += 1;
    else if (step.isError) this.errors += 1;
    if ((step.resultChars ?? 0) > LARGE_RESULT_CHARS) this.largeResults += 1;
  }

  snapshot(): AgentAnomalies {
    const repeatedReads = [...this.reads]
      .filter(([, count]) => count > 1)
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    return {
      denials: this.denials,
      errors: this.errors,
      repeatedReads,
      largeResults: this.largeResults,
    };
  }
}

/** Есть ли что показать. */
export function hasAnomalies(anomalies: AgentAnomalies | undefined): anomalies is AgentAnomalies {
  return Boolean(
    anomalies &&
    (anomalies.denials > 0 ||
      anomalies.errors > 0 ||
      anomalies.largeResults > 0 ||
      anomalies.repeatedReads.length > 0),
  );
}
