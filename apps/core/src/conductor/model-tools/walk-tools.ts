import type { BrowseGap, BrowseStep, BrowseTarget } from '@agentdeck/contracts/core/browse';
import { BROWSE_REFUSALS } from '@agentdeck/contracts/core/browse';
import {
  parseModelCall,
  type BrowserToolName,
  type ModelToolReply,
} from '@agentdeck/contracts/core/model-tools';
import type {
  ActOutcome,
  BrowserAct,
  OriginVerdict,
  WalkPort,
} from '../../adapters/browser/browser.types.ts';
import { SECRET_MASK } from '@agentdeck/dlp/secret-mask';
import { maskSink } from '../../context/sinks/sinks.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { projectRootOf } from '../../platform/paths.ts';
import type { ModelToolDeps, SessionBinding } from './model-tools.types.ts';

/**
 * Инструменты браузера шага `walk` (этап 12, P177/P178) — вход со стороны ядра.
 *
 * Порядок у каждого действия один: схема вызова → шаг идёт → (секрет стенда читается и сразу
 * попадает в маску сессии) → действие на странице → строка `browse.step` → ответ модели. Строка и
 * ответ проходят одну маску: сначала по значению подставленных секретов сессии (короткий пароль
 * детектор формы не узнал бы), потом общая маска выходов к модели (`maskSink`). Строка хранит
 * секрет только ИМЕНЕМ: значение уходит в браузер и больше никуда — ни в журнал, ни в ответ, ни в
 * снимок дерева (Playwright показывает значение поля пароля в снимке открытым текстом).
 *
 * Жест вне умений ядра (`browse_gesture`, клик, открывший выбор файла) — строка `browse.gap` и
 * отказ `unsupported`: отчёт и спек называют шаг непроверенным, страница не тронута.
 */

export const WALK_NOT_WIRED = 'not-wired';
/** Секрет короче — маска по значению съела бы обычные слова, а без маски он ушёл бы в снимок. */
export const WALK_SECRET_MIN = 4;
const SECRET_NAME_PREFIX = 'walk-secret:';
const MASK = SECRET_MASK;
const PROBLEM_MAX = 500;
const VALUE_MAX = 4000;

/** Подставленные значения секретов: порт → сессия → значения (память ядра, не диск). */
const secretsUsed = new WeakMap<WalkPort, Map<string, Set<string>>>();
/** Номер следующего действия шага: задача → шаг → последний n (первое чтение — из журнала). */
const counters = new WeakMap<LiveTask, Map<string, number>>();

const refuse = (code: string, message: string): ModelToolReply => ({ ok: false, code, message });

export function handleWalkTool(
  task: LiveTask,
  b: SessionBinding,
  name: BrowserToolName,
  input: unknown,
  deps: ModelToolDeps,
): ModelToolReply | Promise<ModelToolReply> {
  const parsed = parseModelCall(name, input);
  if (!parsed.ok)
    return { ok: false, code: 'invalid', message: 'call failed its schema', issues: parsed.issues };
  const state = task.state.steps[b.stepId]?.state;
  if (state !== 'running') return refuse('step-not-running', `step is ${state ?? 'unknown'}`);
  const walk = deps.walk;
  if (name === 'browse_gesture') {
    const call = parsed.value as {
      action: BrowseGap['action'];
      target?: BrowseTarget;
      why: string;
    };
    const mask = maskerOf(task, b, walk);
    appendGap(task, b, {
      stepId: b.stepId,
      action: call.action,
      ...(call.target ? { target: maskTarget(call.target, mask) } : {}),
      why: cut(mask(call.why), 2000),
    });
    return refuse(
      BROWSE_REFUSALS.unsupported,
      `${call.action} is not supported by the core browser: the gap is recorded as not checked`,
    );
  }
  if (!walk) return refuse(WALK_NOT_WIRED, 'browser tools are not connected');
  return act(task, b, name, parsed.value as Record<string, unknown>, walk);
}

async function act(
  task: LiveTask,
  b: SessionBinding,
  name: Exclude<BrowserToolName, 'browse_gesture'>,
  call: Record<string, unknown>,
  walk: WalkPort,
): Promise<ModelToolReply> {
  const target = call.target as BrowseTarget | undefined;
  let browserAct: BrowserAct;
  let secretName: string | undefined;
  switch (name) {
    case 'browse_open':
      browserAct = { action: 'open', url: call.url as string };
      break;
    case 'browse_click':
      browserAct = { action: 'click', target: target! };
      break;
    case 'browse_fill': {
      const secret = call.secret as { name: string } | undefined;
      let value = call.value as string | undefined;
      let origin: string | undefined;
      if (secret) {
        const got = resolveSecret(task, b, walk, secret.name);
        if ('refused' in got) return refuse(got.refused, got.message);
        value = got.value;
        origin = got.origin;
        secretName = secret.name;
      }
      browserAct = {
        action: 'fill',
        target: target!,
        value: value ?? '',
        ...(origin !== undefined ? { origin } : {}),
      };
      break;
    }
    case 'browse_press':
      browserAct = { action: 'press', key: call.key as string, ...(target ? { target } : {}) };
      break;
    case 'browse_select':
      browserAct = { action: 'select', target: target!, value: call.value as string };
      break;
    case 'browse_expect':
      browserAct = {
        action: 'expect',
        expect: call.expect as BrowseStep['expect'] & string,
        ...(target ? { target } : {}),
        ...(call.value !== undefined ? { value: call.value as string } : {}),
      };
      break;
    case 'browse_snapshot':
      browserAct = { action: 'snapshot', ...(target ? { target } : {}) };
      break;
  }
  const roots = rootsOf(task);
  if (browserAct.action === 'open') {
    const gate = walk.stands.open(roots, browserAct.url);
    if (!gate.ok) return offStand(task, b, walk, gate, browserAct, 'before');
  }
  // Каждый переход страницы (перенаправление, ссылка, скрипт) — те же ворота, и ДО запроса:
  // чужой хост не получает ни одного обращения, даже того, что потом сбросили бы.
  const outcome = await walk.driver.act(b.sessionId, browserAct, (url) =>
    walk.stands.stay(roots, url),
  );
  if ('refused' in outcome) {
    return refuse(
      outcome.refused === 'no-browser' ? BROWSE_REFUSALS.noBrowser : outcome.refused,
      outcome.message,
    );
  }
  if (outcome.blocked) return offStand(task, b, walk, outcome.blocked, browserAct, 'blocked');
  // Куда страница пришла — второй рубеж: переход без сетевого запроса ворота перехода не видят.
  const stay = walk.stands.stay(roots, outcome.url);
  if (!stay.ok) return offStand(task, b, walk, stay, browserAct, 'left');
  const mask = maskerOf(task, b, walk);
  const row = stepRow(task, b, browserAct, outcome, secretName, call, mask);
  task.append({
    kind: 'browse.step',
    actor: `session:${b.sessionId}`,
    stepId: b.stepId,
    sessionId: b.sessionId,
    data: row,
  });
  if (outcome.filePick) {
    appendGap(task, b, {
      stepId: b.stepId,
      action: 'file-pick',
      ...(row.target ? { target: row.target } : {}),
      why: 'the click opened a file chooser; the core browser does not pick files',
    });
    return refuse(
      BROWSE_REFUSALS.unsupported,
      'the click opened a file chooser: file picking is not supported, the gap is recorded',
    );
  }
  return {
    ok: true,
    result: {
      n: row.n,
      action: row.action,
      ok: row.ok,
      url: row.url,
      checks: row.checks,
      ...(row.problems ? { problems: row.problems } : {}),
      ...(outcome.snapshot !== undefined ? { snapshot: mask(outcome.snapshot) } : {}),
    },
  };
}

/**
 * Адрес вне стендов проекта и петли: строка `browse.gap` (шаг не проверен), строки `browse.step`
 * нет, модель получает отказ `origin-not-allowed` с причиной. `before` — открытие отказано до
 * перехода; `blocked` — переход после действия остановлен до запроса; `left` — страница уже там
 * (переход без запроса). В двух последних страница сбрасывается на пустую — ни снимок, ни
 * следующее действие её не увидят.
 */
async function offStand(
  task: LiveTask,
  b: SessionBinding,
  walk: WalkPort,
  gate: Extract<OriginVerdict, { ok: false }>,
  browserAct: BrowserAct,
  when: 'before' | 'blocked' | 'left',
): Promise<ModelToolReply> {
  if (when !== 'before') await walk.driver.act(b.sessionId, { action: 'open', url: 'about:blank' });
  const mask = maskerOf(task, b, walk);
  const target = 'target' in browserAct && browserAct.target ? browserAct.target : undefined;
  const after: Record<typeof when, string> = {
    before: '',
    blocked: `; the navigation after ${browserAct.action} was stopped before its request was sent and the page was reset to about:blank`,
    left: `; the page went there after ${browserAct.action} and was reset to about:blank`,
  };
  const why = `${gate.why}${after[when]}`;
  appendGap(task, b, {
    stepId: b.stepId,
    action: 'other',
    ...(target ? { target: maskTarget(target, mask) } : {}),
    why: cut(mask(why), 2000),
  });
  return refuse(gate.code, cut(mask(why), 2000));
}

/** Секрет стенда: значение — в маску сессии ДО действия, чтобы любое его эхо уже пряталось. */
function resolveSecret(
  task: LiveTask,
  b: SessionBinding,
  walk: WalkPort,
  name: string,
): { value: string; origin: string } | { refused: string; message: string } {
  const pageUrl = walk.driver.urlOf(b.sessionId) ?? '';
  const got = walk.secrets.read(rootsOf(task), name, pageUrl);
  if ('refused' in got) return got;
  // Читатель отдал значение — адрес страницы разобрался и того же источника, что стенд секрета.
  const origin = new URL(pageUrl).origin;
  if (got.value.length < WALK_SECRET_MIN) {
    return {
      refused: 'secret-unmaskable',
      message: `${name} is shorter than ${WALK_SECRET_MIN} characters: it could not be masked`,
    };
  }
  walk.mask.record(b.sessionId, `${SECRET_NAME_PREFIX}${name}`, got.value);
  const bySession = secretsUsed.get(walk) ?? new Map<string, Set<string>>();
  secretsUsed.set(walk, bySession);
  const mine = bySession.get(b.sessionId) ?? new Set<string>();
  mine.add(got.value);
  bySession.set(b.sessionId, mine);
  return { value: got.value, origin };
}

/**
 * Корни проекта задачи: закреплённые репозитории (с подпапкой проекта, если он не в вершине —
 * доступы стенда лежат в `<проект>/.agent/tests`), чат на месте — его папка.
 */
function rootsOf(task: LiveTask): string[] {
  const created = task.state.created;
  return created ? projectRootsOf(created) : [];
}

/** Те же корни по строке `task.created` — ими читает доступы стенда и живая проверка шва. */
export function projectRootsOf(created: {
  repos: readonly { path: string; subPath?: string | undefined }[];
  folder?: string | undefined;
}): string[] {
  const roots = created.repos.map((r) => projectRootOf(r));
  if (created.folder) roots.push(created.folder);
  return roots;
}

type Mask = (text: string) => string;

function maskerOf(task: LiveTask, b: SessionBinding, walk: WalkPort | undefined): Mask {
  const own = [...(walk ? (secretsUsed.get(walk)?.get(b.sessionId) ?? []) : [])]
    .filter((v) => v.length >= WALK_SECRET_MIN)
    // Длинные — первыми: секрет, содержащий другой, прячется целиком.
    .sort((x, y) => y.length - x.length);
  const known = walk ? walk.known(task.taskId, b.sessionId) : [];
  return (text) => {
    let out = text;
    for (const value of own) if (out.includes(value)) out = out.split(value).join(MASK);
    return maskSink(out, 'excerpt', known).text;
  };
}

function maskTarget(target: BrowseTarget, mask: Mask): BrowseTarget {
  if ('role' in target) return { role: target.role, name: mask(target.name) };
  if ('testId' in target) return { testId: mask(target.testId) };
  if ('label' in target) return { label: mask(target.label) };
  return { text: mask(target.text) };
}

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function nextN(task: LiveTask, stepId: string): number {
  let byStep = counters.get(task);
  if (!byStep) {
    byStep = new Map();
    counters.set(task, byStep);
  }
  let last = byStep.get(stepId);
  if (last === undefined) {
    last = readJournalLines(task.dir, task.taskId).lines.filter(
      (l) => l.kind === 'browse.step' && l.stepId === stepId,
    ).length;
  }
  byStep.set(stepId, last + 1);
  return last + 1;
}

function stepRow(
  task: LiveTask,
  b: SessionBinding,
  act: BrowserAct,
  outcome: ActOutcome,
  secretName: string | undefined,
  call: Record<string, unknown>,
  mask: Mask,
): BrowseStep {
  const problems = outcome.problems.map((p) => cut(mask(p), PROBLEM_MAX)).slice(0, 20);
  // Значение строки — то, что модель прислала (клавиша, опция, ожидаемое, адрес), не подставленное.
  let value: string | undefined;
  if (act.action === 'open') value = act.url;
  else if (act.action === 'press') value = act.key;
  else if (act.action === 'select' || act.action === 'expect') value = act.value;
  else if (act.action === 'fill' && !secretName) value = call.value as string;
  const target = 'target' in act && act.target ? maskTarget(act.target, mask) : undefined;
  return {
    stepId: b.stepId,
    n: nextN(task, b.stepId),
    action: act.action,
    ...(target ? { target } : {}),
    ...(value !== undefined ? { value: cut(mask(value), VALUE_MAX) } : {}),
    ...(secretName ? { secret: { name: secretName } } : {}),
    ...(act.action === 'expect' ? { expect: act.expect } : {}),
    url: cut(mask(outcome.url), VALUE_MAX),
    checks: outcome.checks,
    ...(problems.length > 0 ? { problems } : {}),
    ok: outcome.ok,
  };
}

function appendGap(task: LiveTask, b: SessionBinding, gap: BrowseGap): void {
  task.append({
    kind: 'browse.gap',
    actor: `session:${b.sessionId}`,
    stepId: b.stepId,
    sessionId: b.sessionId,
    data: gap,
  });
}
