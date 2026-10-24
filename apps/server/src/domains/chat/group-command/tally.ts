import type { KillTargets } from './kill.ts';
import type { CodeRule } from './risky.ts';
import type { SegmentVerdict } from './walk.ts';

interface Effects {
  writes: boolean;
  lease: boolean;
  deletes: boolean;
  /**
   * Номера процессов и порты, которые команда гасит (N3): своё ли это, по
   * тексту не узнать — маршрут прав сверяет их с процессами группы. Цель,
   * которую не назвать числом, — `unnamed`: отказ агенту, не карточка.
   */
  kills?: KillTargets;
}

export type GroupCommandVerdict =
  | ({ kind: 'routine' } & Effects)
  | { kind: 'danger' }
  | ({ kind: 'other'; texts: string[]; rules: CodeRule[] } & Effects);

/** Итог по всем звеньям команды, включая подстановки и сценарии на входе оболочки. */
export class Tally {
  danger = false;
  private other = false;
  private seen = false;
  private readonly effects: Effects = { writes: false, lease: false, deletes: false };
  private readonly pids = new Set<number>();
  private readonly ports = new Set<number>();
  private unnamed = false;
  private readonly texts: string[] = [];
  private readonly rules = new Set<CodeRule>();

  /** `text` — слова звена: для «прочего» их судят правила чата. */
  add(verdict: SegmentVerdict, text?: string): void {
    this.seen = true;
    if (verdict.kind === 'danger') this.danger = true;
    else if (verdict.kind === 'other') {
      this.other = true;
      for (const rule of verdict.rules ?? []) this.rules.add(rule);
      if (!verdict.checked && text) this.texts.push(text);
    } else {
      this.effects.writes ||= verdict.writes === true;
      this.effects.lease ||= verdict.lease === true;
      this.effects.deletes ||= verdict.deletes === true;
      for (const pid of verdict.kills?.pids ?? []) this.pids.add(pid);
      for (const port of verdict.kills?.ports ?? []) this.ports.add(port);
      this.unnamed ||= verdict.kills?.unnamed === true;
    }
  }

  result(): GroupCommandVerdict {
    if (this.danger) return { kind: 'danger' };
    const kills =
      this.pids.size + this.ports.size > 0 || this.unnamed
        ? {
            kills: {
              pids: [...this.pids],
              ports: [...this.ports],
              ...(this.unnamed ? { unnamed: true } : {}),
            },
          }
        : {};
    const effects = { ...this.effects, ...kills };
    if (this.other || !this.seen) {
      return { kind: 'other', texts: this.texts, rules: [...this.rules], ...effects };
    }
    return { kind: 'routine', ...effects };
  }
}
