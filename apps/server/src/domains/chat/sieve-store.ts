import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  acceptLearned,
  checkSimilarity,
  SAME_SIEVE_SIMILARITY,
  type LearnedRejection,
  type LearnedSieve,
  type LearnedSieveRow,
  type SieveClass,
  type SievesView,
  type SieveTally,
  type SieveTallyCell,
} from '@agentdeck/contracts/sieves';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io.ts';

/**
 * Выученные сита и счёт блокеров — память панели поверх всех проектов
 * (`<appData>/sieves.json`), а не проекта: класс блокера («доки разошлись с
 * ответом сервера») повторяется между репозиториями, и сито, выученное в одном,
 * полезно в другом, если оно помечено `global`.
 *
 * Счёт (`tally`) — мерило «окупается ли»: сколько блокеров ушло в MR
 * (`escaped` — тред ревьюера, разложенный группой в сито) и сколько панель
 * поймала до MR (`caught` — пробел сита на проверке доставки), по классам и
 * месяцам. Сита стоят времени ревью; если `escaped` не падает, сито не держит.
 *
 * Выученное сито рождается `proposed` и в задания не идёт, пока его не примет
 * человек (ревью сит, 28.09): его текст пишет модель по реплике любого
 * комментатора MR, а принятое сито становится постоянным заданием. Общим
 * (`global`) сито тоже делает только человек — модель и повтор в другом проекте
 * лишь советуют (`suggestedScope`).
 */

const FILE = 'sieves.json';
/** Больше — задание звена превращается в простыню; вытесняется давно не виденное. */
const LEARNED_MAX = 40;
/** Сколько выученных сит уходит в одно задание. */
export const LEARNED_IN_PROMPT = 8;
/** Источников у одного сита — хватит доказать повторяемость. */
const SOURCES_MAX = 10;

interface SieveFile extends SievesView {
  version: 1;
  tally: SieveTally;
}

export interface LearnOutcome {
  accepted: LearnedSieve[];
  rejected: { row: LearnedSieveRow; reason: LearnedRejection }[];
}

function empty(): SieveFile {
  return { version: 1, learned: [], tally: {} };
}

export class SieveStore {
  private readonly file: string;
  private readonly now: () => Date;

  constructor(appDataDir: string, now: () => Date = () => new Date()) {
    this.file = join(appDataDir, FILE);
    this.now = now;
  }

  private read(): SieveFile {
    try {
      const data = readJsonFile<SieveFile | undefined>(this.file, undefined);
      if (!data || data.version !== 1 || !Array.isArray(data.learned)) return empty();
      // Запись до статусов — непринятая: человек её ещё не видел.
      const learned = data.learned.map((sieve) => ({
        ...sieve,
        status: sieve.status ?? ('proposed' as const),
      }));
      return { version: 1, learned, tally: data.tally ?? {} };
    } catch {
      // Битый файл — сита начинаются заново, панель встаёт: это подсказка
      // заданию, а не данные человека.
      return empty();
    }
  }

  private write(data: SieveFile): void {
    writeJsonFile(this.file, data);
  }

  private month(): string {
    return this.now().toISOString().slice(0, 7);
  }

  private bump(data: SieveFile, cls: SieveClass, field: keyof SieveTallyCell): void {
    const month = (data.tally[this.month()] ??= {});
    const cell = (month[cls] ??= { escaped: 0, caught: 0 });
    cell[field] += 1;
  }

  /**
   * Записать сита, выученные группой по тредам её MR, предложенными. `relayed` —
   * ссылки тредов, которые панель САМА переслала группе: сито со ссылкой вне них
   * не принимается. Похожее сито того же класса не плодится — к нему добавляется
   * источник.
   */
  learn(input: {
    rows: readonly LearnedSieveRow[];
    relayed: readonly string[];
    projectPath: string;
    mr?: string;
  }): LearnOutcome {
    const data = this.read();
    const at = this.now().toISOString();
    const outcome: LearnOutcome = { accepted: [], rejected: [] };
    const seenThreads = new Set<string>();

    for (const row of input.rows) {
      const reason = acceptLearned(row, input.relayed);
      if (reason) {
        outcome.rejected.push({ row, reason });
        continue;
      }
      // Один тред — один блокер в счёте, сколько бы сит группа из него ни вывела и
      // сколько бы раз наблюдатель его ни переслал: тред, уже записанный в
      // источники, в счёт не идёт снова (ревью сит, 28.09).
      const known = data.learned.some((sieve) =>
        sieve.sources.some((item) => item.thread === row.thread),
      );
      if (!known && !seenThreads.has(row.thread)) {
        seenThreads.add(row.thread);
        this.bump(data, row.class, 'escaped');
      }
      const source = { thread: row.thread, ...(input.mr ? { mr: input.mr } : {}), at };
      // Похожее ищется по ВСЕМ проектам: тот же блокер в соседнем проекте — не
      // новое сито, а повод предложить прежнее общим (ниже).
      const same = data.learned.find(
        (sieve) =>
          sieve.class === row.class &&
          checkSimilarity(sieve.check, row.check) >= SAME_SIEVE_SIMILARITY,
      );
      if (same) {
        if (!same.sources.some((item) => item.thread === row.thread)) {
          same.sources = [...same.sources, source].slice(-SOURCES_MAX);
        }
        same.lastSeenAt = at;
        // Проект, где тот же блокер всплыл снова, — повод предложить сито общим.
        if (same.scope === 'project' && same.projectPath !== input.projectPath) {
          same.suggestedScope = 'global';
        }
        outcome.accepted.push(same);
        continue;
      }
      const sieve: LearnedSieve = {
        id: createHash('sha256')
          .update(`${row.class}\0${row.check}\0${at}`)
          .digest('hex')
          .slice(0, 12),
        class: row.class,
        status: 'proposed',
        scope: 'project',
        projectPath: input.projectPath,
        ...(row.scope === 'global' ? { suggestedScope: 'global' as const } : {}),
        trigger: row.trigger,
        check: row.check,
        sources: [source],
        createdAt: at,
        lastSeenAt: at,
      };
      data.learned.push(sieve);
      outcome.accepted.push(sieve);
    }

    if (data.learned.length > LEARNED_MAX) {
      data.learned.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
      data.learned = data.learned.slice(0, LEARNED_MAX);
    }
    if (outcome.accepted.length > 0 || seenThreads.size > 0) this.write(data);
    return outcome;
  }

  /** Панель поймала блокер до MR — по классу сита. */
  caught(classes: readonly SieveClass[]): void {
    if (classes.length === 0) return;
    const data = this.read();
    for (const cls of classes) this.bump(data, cls, 'caught');
    this.write(data);
  }

  /** Сита для задания звена в этом проекте: принятые общие и свои, чаще виденные первыми. */
  forProject(projectPath: string, limit = LEARNED_IN_PROMPT): LearnedSieve[] {
    return this.read()
      .learned.filter(
        (sieve) =>
          sieve.status === 'active' &&
          (sieve.scope === 'global' || sieve.projectPath === projectPath),
      )
      .sort(
        (a, b) => b.sources.length - a.sources.length || b.lastSeenAt.localeCompare(a.lastSeenAt),
      )
      .slice(0, limit);
  }

  list(): SieveFile {
    return this.read();
  }

  /**
   * Человек принял сито — для его проекта или для всех. `global` снимает привязку к
   * проекту; `project` у сита без проекта (общего) охват не сужает. `false` — такого нет.
   */
  accept(id: string, scope: 'project' | 'global'): boolean {
    const data = this.read();
    const sieve = data.learned.find((item) => item.id === id);
    if (!sieve) return false;
    sieve.status = 'active';
    if (scope === 'global') {
      sieve.scope = 'global';
      delete sieve.projectPath;
      delete sieve.suggestedScope;
    }
    this.write(data);
    return true;
  }

  /** Человек убрал сито. `false` — такого нет. */
  remove(id: string): boolean {
    const data = this.read();
    const next = data.learned.filter((sieve) => sieve.id !== id);
    if (next.length === data.learned.length) return false;
    this.write({ ...data, learned: next });
    return true;
  }
}
