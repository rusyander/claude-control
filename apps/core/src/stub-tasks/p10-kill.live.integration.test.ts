import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { STALE_MS } from '../journal/lease.ts';
import { HAPPY_PATH } from './__fixtures__/library/happy-path.ts';
import type { AdapterUnderTest, ChildResult, KillPoint } from './__fixtures__/e2e/e2e.types.ts';
import { journalKillHit, PERMIT_KILL_POINTS } from './__fixtures__/e2e/kill-match.ts';
import {
  commitsIn,
  configFor,
  hasCli,
  journalOf,
  makeStand,
  runCore,
  sweepStand,
  taskIdOf,
  type Stand,
} from './__fixtures__/e2e/stand.ts';

/**
 * P10 на настоящем CLI: ядро убито (SIGKILL) после каждой строки журнала пути задачи-заглушки и
 * внутри каждого действия outbox (эффект сделан, `action.done` нет); новое ядро продолжает ту же
 * задачу по журналу. Итог каждой точки — ровно один коммит с тем же файлом и тот же набор
 * решений о праве, что у чистого прогона: ни одно действие не сделано дважды, ни одно не потеряно.
 *
 * Живых CLI в контейнере Linux нет — там прогон пропускается.
 */

const CLIS: Record<AdapterUnderTest, string> = {
  claude: claudeRunFacts.binary.command,
  qwen: qwenRunFacts.binary.command,
};

interface Point {
  name: string;
  kill: KillPoint;
  /** Сессия уже записана: новое ядро обязано прикрепиться к ней, а не запустить другую. */
  sameSession?: boolean;
  /**
   * Прежнее ядро успело поднять хост, но не записало `session.started` (B1 r1 C2): новое ядро
   * снимает его дерево (сирота) и запускает свою сессию — второй `process-start` по правилу
   * продолжения, а не повтор вслепую. Без этого флага хоста прежнего ядра нет.
   */
  orphanHost?: boolean;
}

const J = (kind: KillPoint & { at: 'journal' }): KillPoint => kind;
const POINTS: Point[] = [
  { name: 'task.created', kill: J({ at: 'journal', kind: 'task.created', nth: 1 }) },
  { name: 'unit.created', kill: J({ at: 'journal', kind: 'unit.created', nth: 1 }) },
  {
    name: 'copy-create started',
    kill: J({ at: 'journal', kind: 'action.started', nth: 1, action: 'copy-create' }),
  },
  { name: 'copy-create effect', kill: { at: 'effect', action: 'copy-create' } },
  {
    name: 'copy-create done',
    kill: J({ at: 'journal', kind: 'action.done', nth: 1, action: 'copy-create' }),
  },
  { name: 'stub lease', kill: J({ at: 'journal', kind: 'resource.created', nth: 1 }) },
  { name: 'step.started', kill: J({ at: 'journal', kind: 'step.started', nth: 1 }) },
  { name: 'step running', kill: J({ at: 'journal', kind: 'step.transition', nth: 1 }) },
  // Дорога сессии решает совместимость до аренды и запуска: смерть после решения — новое ядро
  // решает заново, аренды и процесса прежнего ядра нет.
  {
    name: 'compat decision',
    kill: J({ at: 'journal', kind: 'decision', nth: 1, decisionClass: 'compat' }),
  },
  {
    name: 'process-start started',
    kill: J({ at: 'journal', kind: 'action.started', nth: 1, action: 'process-start' }),
  },
  {
    name: 'process-start effect',
    kill: { at: 'effect', action: 'process-start' },
    orphanHost: true,
  },
  {
    name: 'process-start done',
    kill: J({ at: 'journal', kind: 'action.done', nth: 1, action: 'process-start' }),
    orphanHost: true,
  },
  {
    name: 'session.started',
    kill: J({ at: 'journal', kind: 'session.started', nth: 1 }),
    sameSession: true,
  },
  {
    name: 'session live',
    kill: J({ at: 'journal', kind: 'session.transition', nth: 1 }),
    sameSession: true,
  },
  // Решения о праве: вопросы CLI 1–3 (те же вызовы, что до дороги сессии) и хук ядра отдельно.
  ...PERMIT_KILL_POINTS.map((point) => ({ ...point, sameSession: true })),
  {
    name: 'step.claimed',
    kill: J({ at: 'journal', kind: 'step.claimed', nth: 1 }),
    sameSession: true,
  },
];

/** id разговора CLI во всех строках stdout.log сессии, без повторов. */
function conversationsIn(s: Stand, sessionId: string): string[] {
  const ids = new Set<string>();
  for (const line of readFileSync(join(s.sessions, sessionId, 'stdout.log'), 'utf8').split('\n')) {
    const id = /"session_id":"([^"]+)"/.exec(line)?.[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * Та же сессия довела шаг (01 §Sessions at core death, P89): новое ядро ничего не запустило,
 * прикрепилось к хосту из `session.started` (pid + старт), разговор CLI тот же, заявление шага
 * сделала эта сессия.
 */
function expectSameSession(s: Stand, lines: JournalLine[], result: ChildResult): void {
  const started = lines.filter((l) => l.kind === 'session.started');
  expect(started, 'one session.started in the whole journal').toHaveLength(1);
  const first = started[0]!.data as { sessionId: string; hostPid: number; hostStart: string };
  expect(result.launched, 'the restarted core launched nothing').toEqual([]);
  expect(result.stoppedOrphans, 'the restarted core stopped nothing').toEqual([]);
  expect(result.reattached.map((r) => [r.sessionId, r.hostPid, r.hostStart])).toEqual([
    [first.sessionId, first.hostPid, first.hostStart],
  ]);
  const conversations = conversationsIn(s, first.sessionId);
  expect(conversations, 'one CLI conversation in the session output').toHaveLength(1);
  expect(result.reattached[0]!.conversationId).toBe(conversations[0]);
  const claims = lines.filter((l) => l.kind === 'step.claimed');
  expect((claims[0]!.data as { sessionId: string }).sessionId).toBe(first.sessionId);
  const ended = lines.filter(
    (l) =>
      l.kind === 'session.transition' &&
      (l.data as { sessionId: string; to: string }).sessionId === first.sessionId &&
      (l.data as { to: string }).to !== 'live',
  );
  // Сессию закрывает только конец шага — ни `lost`, ни `ended` до заявления.
  expect(ended.every((l) => l.seq > claims[0]!.seq)).toBe(true);
}

/** Решения о праве без привязки к стенду: путь копии заменён меткой. */
function permitSet(lines: JournalLine[], copy: string): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.kind !== 'decision') continue;
    const data = line.data as { class: string; output: Record<string, unknown> };
    if (data.class !== 'permit') continue;
    const { action, target, tool, allow } = data.output;
    const where = String(target).split(copy).join('<copy>');
    seen.add(JSON.stringify({ action, target: where, tool, allow }));
  }
  return [...seen].sort();
}

/** Сколько раз эффект действия завершён (`action.done`) — двойного эффекта быть не должно. */
function doneCount(lines: JournalLine[]): Record<string, number> {
  const kinds = new Map<string, string>();
  const out: Record<string, number> = {};
  for (const line of lines) {
    const data = line.data as { actionId?: string; kind?: string };
    if (line.kind === 'action.started' && data.actionId && data.kind)
      kinds.set(data.actionId, data.kind);
    if (line.kind === 'action.done' && data.actionId) {
      const kind = kinds.get(data.actionId) ?? '?';
      out[kind] = (out[kind] ?? 0) + 1;
    }
  }
  return out;
}

const stands: Stand[] = [];
afterAll(async () => {
  for (const s of stands) await sweepStand(s);
}, 180_000);

for (const adapter of ['claude', 'qwen'] as const) {
  const present = hasCli(CLIS[adapter]);
  describe.skipIf(!present)(`P10 kill matrix on the real ${adapter} CLI`, () => {
    let baseline: string[] = [];
    let cleanLines: JournalLine[] = [];
    let cleanCopy = '';
    beforeAll(async () => {
      const s = makeStand(HAPPY_PATH, `p10-clean-${adapter}-`);
      stands.push(s);
      const run = await runCore(s, configFor(s, adapter, 'claimed'));
      expect(run.result?.outcome, JSON.stringify(run.notes)).toBe('claimed');
      cleanLines = journalOf(s, run.result!.taskId);
      cleanCopy = run.result!.copy;
      baseline = permitSet(cleanLines, cleanCopy);
      expect(baseline.length).toBeGreaterThan(0);
    }, 300_000);

    it('permit kill points 1–3 land on three different tool calls of the clean run; the hook point on its own', () => {
      // У каждого вызова инструмента ровно одно решение хука ядра (Claude спрашивает хук до
      // вопроса CLI, Qwen — после): номер вызова строки = число решений хука с seq не больше её
      // seq; между двумя вопросами разных вызовов всегда лежит решение хука. Цель Bash —
      // программа (`git`), поэтому различие вызовов меряется номером, а не целью.
      const hooks = cleanLines
        .filter((l) => {
          const data = l.data as { class?: string; output?: { road?: string } };
          return l.kind === 'decision' && data.class === 'permit' && data.output?.road === 'hook';
        })
        .map((l) => l.seq);
      const landed = (kill: Parameters<typeof journalKillHit>[0]): { call: number; at: string } => {
        const hit = journalKillHit(kill);
        const line = cleanLines.find((l) => hit(l, { actions: {} } as never));
        const out = (line?.data as { output?: { tool?: string; target?: unknown } } | undefined)
          ?.output;
        if (!line || !out) return { call: 0, at: 'none' };
        const where = String(out.target).split(cleanCopy).join('<copy>');
        return { call: hooks.filter((seq) => seq <= line.seq).length, at: `${out.tool} ${where}` };
      };
      const now = PERMIT_KILL_POINTS.map((p) => ({ point: p.name, ...landed(p.kill) }));
      // Счёт до дороги сессии (без дороги решения): для сравнения покрытия, не для проверки.
      const blind = [1, 2, 3].map((nth) => ({
        point: `blind permit ${nth}`,
        ...landed({ at: 'journal', kind: 'decision', nth, decisionClass: 'permit' }),
      }));
      console.log(`[p10 coverage ${adapter}] ${JSON.stringify({ now, blind })}`);
      const permits = now.slice(0, 3);
      expect(permits.map((p) => p.at)).not.toContain('none');
      expect(new Set(permits.map((p) => p.call)).size).toBe(3);
      expect(now[3]!.at).not.toBe('none');
    });

    describe.concurrent('killed, restarted, finished once', () => {
      it.each(POINTS)(
        'kill at $name → one commit, the clean run’s permit decisions, no effect twice',
        async (point) => {
          const s = makeStand(HAPPY_PATH, `p10-${adapter}-`);
          stands.push(s);
          const first = await runCore(s, configFor(s, adapter, 'claimed', { kill: point.kill }));
          // Точка сработала: ядро умерло в ней, а не дошло до конца само.
          expect(first.killed, JSON.stringify(first.notes)).toHaveLength(1);
          expect(first.result).toBeUndefined();
          const taskId = taskIdOf(first);
          // Аренду задачи перехватывают только у мёртвого И замолчавшего держателя (`STALE_MS`).
          const diedAt = Number(first.killed[0]!.at);
          await new Promise((r) =>
            setTimeout(r, Math.max(0, diedAt + STALE_MS + 1_500 - Date.now())),
          );

          const second = await runCore(s, configFor(s, adapter, 'claimed', { taskId }));
          expect(second.killed).toHaveLength(0);
          const result = second.result;
          expect(
            result,
            `${JSON.stringify(second.notes)}\n${second.stderr.slice(-2000)}`,
          ).toBeDefined();
          const lines = journalOf(s, taskId);

          expect(result!.outcome, JSON.stringify(result!.events)).toBe('claimed');
          expect(result!.stepState).toBe('checking');
          const e2e = HAPPY_PATH.e2e!;
          const repo = commitsIn(
            result!.copy,
            HAPPY_PATH.input.repo.baseBranch,
            Object.keys(e2e.committed),
          );
          expect(repo.count).toBe(e2e.commits);
          expect(repo.files).toEqual(e2e.committed);
          expect(permitSet(lines, result!.copy)).toEqual(baseline);
          const done = doneCount(lines);
          expect(done['copy-create']).toBe(1);
          expect(lines.filter((l) => l.kind === 'step.claimed')).toHaveLength(1);
          // Хост CLI — тоже эффект (B1 r1 C2): одна записанная сессия на всю задачу, и второй
          // запуск — только там, где хост прежнего ядра остался сиротой и снят.
          expect(lines.filter((l) => l.kind === 'session.started')).toHaveLength(1);
          if (point.sameSession) expectSameSession(s, lines, result!);
          else {
            expect(
              result!.launched,
              'the restarted core launched exactly one session',
            ).toHaveLength(1);
            expect(result!.reattached).toEqual([]);
            if (point.orphanHost) {
              expect(result!.stoppedOrphans, 'the dead core’s host is stopped').toHaveLength(1);
              expect(result!.stoppedOrphans[0]).not.toMatch(/:unknown/);
            } else expect(result!.stoppedOrphans, 'no host to stop').toEqual([]);
          }
          expect(done['process-start'], 'process-start effects').toBe(point.orphanHost ? 2 : 1);
        },
        600_000,
      );
    });
  });
}
