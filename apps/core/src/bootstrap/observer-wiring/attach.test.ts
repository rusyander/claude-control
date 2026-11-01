import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { afterEach, describe, expect, it } from 'vitest';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { Predicate, PredicateCtx } from '../../observer/observer.types.ts';
import { attachObserver } from './attach.ts';

/**
 * Наблюдатель на живой задаче (этап 8, F2) на настоящем журнале: живая строка → `decision` класса
 * `observer` + `signal` с действием каталога; прикрепление пересобирает свёртку и ничего не пишет;
 * ключ вынесенного решения не выходит второй раз и после перезапуска; свои строки наблюдателя
 * второй подписчик видит строго по порядку `seq` (R10 — иначе поток SSE их теряет).
 */

const CTX: PredicateCtx = { windowOf: () => null, now: () => 0 };

/** Срабатывает на чужом сигнале: ключ — его `subject` (сигнал `stall` из каталога: warn → show). */
const onForeignSignal: Predicate<null> = {
  ids: ['stall'],
  init: () => null,
  step: (state, line) => {
    if (line.kind !== 'signal') return { state, verdicts: [] };
    const d = (line as JournalLine<'signal'>).data;
    if (d.signal === 'stall') return { state, verdicts: [] };
    return {
      state,
      verdicts: [
        {
          fired: true,
          signal: 'stall',
          subject: d.subject,
          detail: `after ${d.signal}`,
          reasons: ['test predicate'],
          key: `stall:${d.subject}`,
        },
      ],
    };
  },
};

const PREDICATES = [onForeignSignal as Predicate];

const poke = (task: LiveTask, subject: string): JournalLine =>
  task.append({
    kind: 'signal',
    actor: 'core',
    data: { signal: 'session-snapshot', severity: 'info', subject, detail: '' },
  });

const observerRows = (task: LiveTask): JournalLine[] =>
  readJournalLines(task.dir, task.taskId).lines.filter(
    (l) =>
      (l.kind === 'decision' && (l as JournalLine<'decision'>).data.class === 'observer') ||
      (l.kind === 'signal' && (l as JournalLine<'signal'>).data.signal === 'stall'),
  );

const tasks: LiveTask[] = [];
afterEach(() => {
  for (const t of tasks.splice(0)) t.close();
});

async function fresh(): Promise<LiveTask> {
  const { task } = await openFresh();
  tasks.push(task);
  return task;
}

describe('stage 8 attachObserver on a live journal', () => {
  it('a live line → decision{observer, key} then signal{action} whose cause is the decision', async () => {
    const task = await fresh();
    attachObserver(task, { ctx: CTX, predicates: PREDICATES });
    const poked = poke(task, 'a');
    const [decision, signal] = observerRows(task) as [
      JournalLine<'decision'>,
      JournalLine<'signal'>,
    ];
    expect(decision.data).toMatchObject({
      class: 'observer',
      inputs: [poked.seq],
      output: { fired: true, signal: 'stall', severity: 'warn', action: 'show', key: 'stall:a' },
    });
    expect(signal).toMatchObject({
      cause: decision.seq,
      data: { signal: 'stall', severity: 'warn', action: 'show', subject: 'a' },
    });
  });

  it('attach rebuilds from the journal without writing; history verdicts and written keys do not fire again', async () => {
    const task = await fresh();
    poke(task, 'old');
    const before = readJournalLines(task.dir, task.taskId).lines.length;
    const first = attachObserver(task, { ctx: CTX, predicates: PREDICATES });
    expect(readJournalLines(task.dir, task.taskId).lines).toHaveLength(before);
    expect([...first.fold().keys]).toEqual(['stall:old']);
    // Тот же ключ живой строкой — молчит; новый — решение.
    poke(task, 'old');
    poke(task, 'new');
    expect(observerRows(task).map((l) => l.kind)).toEqual(['decision', 'signal']);
    // «Перезапуск»: новое прикрепление берёт ключ из строки решения и тоже молчит.
    first.detach();
    const second = attachObserver(task, { ctx: CTX, predicates: PREDICATES });
    expect(second.fold().keys.has('stall:new')).toBe(true);
    poke(task, 'new');
    expect(observerRows(task)).toHaveLength(2);
  });

  it('a written decision whose source line was lost in a crash still blocks its key after restart', async () => {
    const task = await fresh();
    // Решение есть, строки, на которой оно родилось, нет (телеметрию потерял крах): пересборка
    // вердикта не повторит, ключ берётся только из строки решения.
    task.append({
      kind: 'decision',
      actor: 'core',
      data: {
        decisionId: '01920000-0000-7000-8000-00000000dec1',
        class: 'observer',
        inputs: [],
        facts: [],
        numbers: {},
        reasons: [],
        output: { fired: true, signal: 'stall', key: 'stall:lost' } as never,
      },
    });
    const attached = attachObserver(task, { ctx: CTX, predicates: PREDICATES });
    expect(attached.fold().keys.has('stall:lost')).toBe(true);
    poke(task, 'lost');
    expect(observerRows(task).map((l) => l.kind)).toEqual(['decision']);
  });

  it('lines the observer appends inside its listener reach a later subscriber in seq order', async () => {
    const task = await fresh();
    attachObserver(task, { ctx: CTX, predicates: PREDICATES });
    const seen: number[] = [];
    task.subscribe((line) => seen.push(line.seq));
    const poked = poke(task, 'x');
    expect(seen).toEqual([poked.seq, poked.seq + 1, poked.seq + 2]);
  });

  it('after detach a live line is not judged', async () => {
    const task = await fresh();
    attachObserver(task, { ctx: CTX, predicates: PREDICATES }).detach();
    poke(task, 'late');
    expect(observerRows(task)).toEqual([]);
  });

  it('a signal missing from the catalog is noted, not written', async () => {
    const task = await fresh();
    const notes: [string, Record<string, unknown>][] = [];
    const unknown: Predicate<null> = { ...onForeignSignal, ids: ['no-such'] };
    const renamed: Predicate = {
      ...(unknown as Predicate),
      step: (s, l, c) => {
        const out = onForeignSignal.step(null, l, c);
        return { state: s, verdicts: out.verdicts.map((v) => ({ ...v, signal: 'no-such' })) };
      },
    };
    attachObserver(task, {
      ctx: CTX,
      predicates: [renamed],
      note: (event, data) => notes.push([event, data]),
    });
    poke(task, 'q');
    expect(observerRows(task)).toEqual([]);
    expect(notes).toEqual([
      ['observer.signal.unknown', { taskId: task.taskId, signal: 'no-such' }],
    ]);
  });
});
