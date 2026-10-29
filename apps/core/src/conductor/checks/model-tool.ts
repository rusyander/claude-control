import type { CheckCall } from '@agentdeck/contracts/core/model-tools';
import type {
  CheckAnswer,
  CheckRequest,
  QueueClass,
  VerdictName,
} from '@agentdeck/contracts/core/records';
import { ANSWER_BUDGET_MS, type CheckService } from './request.ts';

/**
 * Инструмент модели `check` (03 §Model tools, 07) поверх единого входа (G21): модель просит
 * проверку реестра по id или по argv, совпавшему с записью реестра; ядро решает тем же судьёй,
 * что и на дорогах захвата (P02), и гонит само (`exec: 'core'`). Ответ ограничен бюджетом (мост MCP рвёт вызов через 120 с): не успели —
 * `running`, повторный вызов присоединяется к тому же прогону ключа (P68), не запускает второй.
 *
 * `scope` модели: имена единиц реестра — какие единицы гнать; остальное — узкая выборка тестов.
 * Единицы не названы — изменённые единицы копии (посреди работы весь набор — 0, 04:56).
 */

export interface ModelCheckContext {
  taskId: string;
  stepId: string;
  project: string;
  copyDir: string;
  class: QueueClass;
  phase: CheckRequest['phase'];
  /** Имена единиц реестра проекта — чтобы отличить единицу от имени теста в `scope`. */
  registryUnits: string[];
  changedUnits: string[];
  /** Записи реестра, что гонятся по единицам (`unit: 'package'`); остальные — на всей копии `.`. */
  packageChecks: string[];
}

export type ModelCheckVerdict = VerdictName | 'running' | 'deferred' | 'refused' | 'narrowed';

export interface ModelCheckUnit {
  unit: string;
  verdict: ModelCheckVerdict;
  reason: string | null;
  recordId: string | null;
  failing: string[];
  /** Сжатый вывод записи (`.log.gz`, 03:97) — модель читает утверждение, не гоняя заново. */
  logPath: string | null;
}

export interface ModelCheckReply {
  verdict: ModelCheckVerdict;
  reason: string | null;
  recordId: string | null;
  excerpt: string;
  logPath: string | null;
  units: ModelCheckUnit[];
}

/** Класс вердикта и названная причина вместе: одно «env» модели ничего не подсказывает. */
function ranReason(answer: Extract<CheckAnswer, { kind: 'ran' }>): string | null {
  if (!('reason' in answer.verdict)) return answer.note ?? null;
  return answer.note ? `${answer.verdict.reason}: ${answer.note}` : answer.verdict.reason;
}

function unitOf(unit: string, answer: CheckAnswer): Omit<ModelCheckUnit, 'logPath'> {
  switch (answer.kind) {
    case 'replay':
      return {
        unit,
        verdict: answer.verdict,
        reason: answer.header,
        recordId: answer.recordId,
        failing: [],
      };
    case 'ran': {
      const failing = answer.failing.map((f) => (f.file ? `${f.file} > ${f.name}` : f.name));
      // Зелёный без записи — не зелёный: доказательства нет, `step_done` его не примет (P44).
      if (answer.recordId === null && answer.verdict.kind.startsWith('pass'))
        return {
          unit,
          verdict: 'no-verdict',
          reason: `${answer.verdict.kind} not recorded: ${answer.note ?? 'store refused the write'}`,
          recordId: null,
          failing,
        };
      return {
        unit,
        verdict: answer.verdict.kind,
        reason: ranReason(answer),
        recordId: answer.recordId,
        failing,
      };
    }
    case 'absent':
      return {
        unit,
        verdict: 'fail',
        reason: 'absent: not in the registry',
        recordId: answer.recordId,
        failing: [],
      };
    case 'running':
    case 'leased':
      return {
        unit,
        verdict: 'running',
        reason: 'still running: call check again with the same arguments to join it',
        recordId: null,
        failing: [],
      };
    case 'defer':
      return {
        unit,
        verdict: 'deferred',
        reason: `${answer.until}: ${answer.reason}`,
        recordId: null,
        failing: [],
      };
    case 'refuse':
      return {
        unit,
        verdict: 'refused',
        reason: answer.unmet.map((u) => `${u.code} ${u.subject} → ${u.next}`).join('; '),
        recordId: null,
        failing: [],
      };
    case 'narrow':
      return {
        unit,
        verdict: 'narrowed',
        reason: `${answer.reason}; changed units: ${answer.units.join(', ') || 'none'}`,
        recordId: null,
        failing: [],
      };
  }
}

/** Худший вердикт решает: красный > без вердикта > идёт > отложено/отказ/сужено > зелёный. */
const RANK: Record<ModelCheckVerdict, number> = {
  fail: 7,
  'no-verdict': 6,
  running: 5,
  refused: 4,
  deferred: 3,
  narrowed: 2,
  'pass-flaky': 1,
  pass: 0,
};

async function withinBudget(
  work: Promise<CheckAnswer>,
  budgetMs: number,
): Promise<CheckAnswer | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function modelCheck(
  service: Pick<CheckService, 'requestCheck' | 'logPath'>,
  call: CheckCall,
  ctx: ModelCheckContext,
  budgetMs = ANSWER_BUDGET_MS,
): Promise<ModelCheckReply> {
  const scope = call.scope ?? [];
  const named = scope.filter((s) => ctx.registryUnits.includes(s));
  const selection = scope.filter((s) => !ctx.registryUnits.includes(s));
  // argv — единицу найдёт сопоставление с реестром; argv вне реестра вход отклоняет
  // (`not-registered`), ничего не запуская. Проверка не по единицам — вся копия; по единицам —
  // названные, иначе изменённые.
  let units = named.length > 0 ? named : [...ctx.changedUnits];
  if (call.argv !== undefined) units = [''];
  else if (call.checkId !== undefined && !ctx.packageChecks.includes(call.checkId)) units = ['.'];
  const base = {
    road: 'model-tool' as const,
    origin: 'core' as const,
    taskId: ctx.taskId,
    stepId: ctx.stepId,
    project: ctx.project,
    copyDir: ctx.copyDir,
    class: ctx.class,
    phase: ctx.phase,
    selection,
    changedUnits: ctx.changedUnits,
    exec: 'core' as const,
    ...(call.checkId !== undefined ? { checkId: call.checkId } : { argv: call.argv ?? [] }),
  };
  if (units.length === 0) {
    const reply: ModelCheckUnit = {
      unit: '',
      verdict: 'narrowed',
      reason: 'mid-task: no unit changed yet, nothing to check (only changed units run mid-task)',
      recordId: null,
      failing: [],
      logPath: null,
    };
    return { ...reply, excerpt: reply.reason ?? '', units: [reply] };
  }
  const deadline = Date.now() + budgetMs;
  // Единицы — параллельно: очередь сама держит слоты; общий бюджет ответа один на вызов.
  const answers = await Promise.all(
    units.map(async (unit): Promise<ModelCheckUnit> => {
      const req = { ...base, unit };
      const answer = await withinBudget(
        service.requestCheck(req),
        Math.max(0, deadline - Date.now()),
      );
      const out = unitOf(unit, answer ?? { kind: 'running', checkRunId: '', since: Date.now() });
      return { ...out, logPath: out.recordId ? service.logPath(req, out.recordId) : null };
    }),
  );
  const worst = answers.reduce((a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a));
  const excerpt = answers
    .map((a) => {
      const head = `${a.unit || 'argv'}: ${a.verdict}${a.recordId ? ` (${a.recordId})` : ''}`;
      const tail = a.failing.length ? `\n  failing: ${a.failing.join('; ')}` : '';
      return `${head}${a.reason ? ` — ${a.reason}` : ''}${tail}`;
    })
    .join('\n')
    .slice(0, 4_000);
  return {
    verdict: worst.verdict,
    reason: worst.reason,
    recordId: answers.length === 1 ? (answers[0]?.recordId ?? null) : null,
    excerpt,
    // Единиц несколько — путь у каждой в `units`, общий не выбирается.
    logPath: answers.length === 1 ? (answers[0]?.logPath ?? null) : null,
    units: answers,
  };
}
