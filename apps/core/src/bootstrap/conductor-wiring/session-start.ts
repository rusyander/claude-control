import { join } from 'node:path';
import { toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type { DenySet } from '../../adapters/adapter.types.ts';
import { unitCopyOf } from '../../conductor/copy/index.ts';
import { ASK_SYSTEM_ARTIFACT } from '../../conductor/ask/index.ts';
import { inPlaceRootOf, isScratchTask } from '../../conductor/estimate/index.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { SESSION_OS_ENV_NAMES } from '../../platform/base-env.ts';
import { projectRootOf } from '../../platform/paths.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import { scratchDirOf } from '../../platform/scratch.ts';
import { journaledLease } from '../session-road/lease-release.ts';
import type { RoadStart } from '../session-road.ts';
import type { RoadResume } from '../session-road/road.types.ts';
import { conversationOf } from '../economy-wiring/continuation.ts';

/**
 * Запуск сессии шага в продукте (зона B): из чего дорога сессии ядра собирает CLI. Копия — та, что
 * разложил крючок копии (F, `unitCopyOf`), маршрут и модель — суд `tier` шага (A, `s.routing`),
 * аренда — живая из журнала после перезапуска ядра, иначе дорога берёт её у реестра маршрутов.
 */

/** Запреты шага поверх платформы: публикация, `.git`, дом ядра — запреты платформы, их кладёт дорога. */
export const STEP_DENY: DenySet = { paths: [], commands: [], mcpTools: [], tools: [] };

/** Каталог сессии — рядом с журналом задачи: его находит и следующее ядро (прикрепление, P89). */
export const sessionDirOf = (task: LiveTask, sessionId: string): string =>
  join(task.dir, 'sessions', sessionId);

/**
 * Каталог сессии, как его назвал журнал: цель `process-start` — каталог сессии (03 §Launcher).
 * Журнал старше этого правила — по тому же правилу `sessionDirOf`.
 */
export function journaledSessionDir(task: LiveTask, sessionId: string): string {
  for (const action of Object.values(task.state.actions)) {
    if (action.kind !== 'process-start') continue;
    if (action.target.split(/[\\/]/).pop() === sessionId) return action.target;
  }
  return sessionDirOf(task, sessionId);
}

/**
 * Окружение, которое ядро передаёт CLI (пин задачи): переменные, по которым CLI находит дом, вход и
 * свои настройки, — того человека, что запустил ядро. Остальное окружение ядра CLI не нужно.
 */
const PIN_KEYS = [...SESSION_OS_ENV_NAMES, 'CLAUDE_CONFIG_DIR'];

export function processPin(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const pin: Record<string, string> = {};
  for (const key of PIN_KEYS) {
    const value = env[key];
    if (value !== undefined) pin[key] = value;
  }
  return pin;
}

/** Аренда маршрута из журнала задачи — правило живёт у книги аренд дороги. */
export { journaledLease };

/** Системная часть брифа: шаг и копия; само задание (части зон) уходит первым сообщением. */
export function systemBrief(s: StepCtx, copyDir: string): string {
  return [
    'You are running one AgentDeck step.',
    `agentdeck-step: ${s.stepId}`,
    `agentdeck-copy: ${copyDir}`,
    'Work only inside the copy. When the step is done call step_done with this stepId; call blocker if you cannot continue.',
  ].join('\n');
}

/**
 * Системная часть чата: разговор с человеком, без `step_done` (чат закрывает человек, `end-chat`).
 * Место названо как есть — корень проекта по гранту человека или копия; слово человека идёт
 * сообщениями, бриф шага чату не нужен.
 */
export function chatBrief(s: StepCtx, dir: string, inPlace: boolean): string {
  return [
    'You are in an AgentDeck chat with the human.',
    `agentdeck-step: ${s.stepId}`,
    inPlace ? `agentdeck-root: ${dir}` : `agentdeck-copy: ${dir}`,
    inPlace
      ? 'You work in the project root itself (the human granted it when opening the chat); edits land in their working tree.'
      : 'Work only inside the copy.',
    'Answer the human turn by turn. The human closes the chat; there is no step_done here.',
  ].join('\n');
}

/**
 * Системная часть вопроса «ask»: слово панели (`system.md` задачи, под маской) или бриф ядра.
 * Ни копии, ни `step_done`: шаг закрывает ядро на конце первого хода.
 */
export function askBrief(task: LiveTask, s: StepCtx): string {
  const read = readBytesSync(join(task.dir, ASK_SYSTEM_ARTIFACT));
  const system = 'value' in read ? read.value.toString('utf8').trim() : '';
  return [
    `agentdeck-step: ${s.stepId}`,
    system || 'Answer the request in the first message. You have no tools; reply with text only.',
  ].join('\n');
}

type OkTier = Extract<NonNullable<NonNullable<StepCtx['routing']>['tier']>, { ok: true }>;

/** Старт сессии вопроса: место — временный каталог ядра, инструментов CLI нет вовсе. */
function askStart(input: StartInputs, s: StepCtx, sessionId: string, tier: OkTier): StartOutcome {
  const { task } = input;
  const ask = task.state.created?.ask;
  if (!ask) return { ok: false, reason: 'ask task without its ask facts' };
  return {
    ok: true,
    start: {
      task,
      stepId: s.stepId,
      stepKind: s.def.kind,
      adapterId: tier.adapter,
      routeId: tier.route.id,
      model: tier.model,
      ...(tier.effort ? { effort: tier.effort } : {}),
      sessionId,
      dir: journaledSessionDir(task, sessionId),
      cwd: scratchDirOf(task.taskId),
      // Дописка набора панели чужому CLI (G13, `fields.session.append`) — после брифа вопроса.
      brief: [askBrief(task, s), task.state.created?.session?.append?.trim() ?? '']
        .filter(Boolean)
        .join('\n\n'),
      deny: STEP_DENY,
      tools: 'none',
      // Слой человека в вопрос не идёт: служебный ход панели не наследует хуки и навыки проекта.
      layer: { hooks: 'off', skills: 'off' },
      // Окружение набора (G13, `fields.session.env`) — только из книги в памяти, как у чата.
      pin: sessionPin(input),
      ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
      ask: {
        bridge: ask.tools === 'panel-bridge' && ask.bridge ? ask.bridge : null,
        ...(ask.consumer ? { consumer: ask.consumer } : {}),
        ...(ask.images?.length ? { images: ask.images.length } : {}),
      },
    },
  };
}

export interface StartInputs {
  task: LiveTask;
  pin: Record<string, string>;
  pathPrefix?: readonly string[];
  /** Значения окружения задачи из книги в памяти (`TaskEnvBook`, этап 10 F6); нет — книга пуста. */
  env?: Readonly<Record<string, string>>;
}

/**
 * Пин сеанса с окружением задачи: имена `task.created.session.env` берутся ТОЛЬКО из книги. Нет
 * значения — переменная снимается и с пина ядра: иначе после перезапуска ядра песочница тихо
 * пошла бы на настоящем `CLAUDE_CONFIG_DIR` человека; отказ по имени — у дороги (`taskEnvRefusal`).
 */
export function sessionPin(input: StartInputs): Record<string, string> {
  const names = input.task.state.created?.session?.env ?? [];
  if (names.length === 0) return input.pin;
  const pin = { ...input.pin };
  for (const name of names) {
    const value = input.env?.[name];
    if (value === undefined) delete pin[name];
    else pin[name] = value;
  }
  return pin;
}

/**
 * Бриф чата: `session.brief = 'none'` — без строки ядра (песочница проверяет слой человека, бриф
 * ядра подмешался бы к проверяемому); иначе бриф чата как есть. Дописка вызывающего
 * (`session.append`, G6: строка о тестах, строка профиля, блок набора) — после брифа ядра и без
 * него: системный промпт несёт каждый переходник, так она доходит до любого CLI.
 */
/** Репозиторий единицы (`unit.repoKey`; без ключа — первый). */
function unitRepoOf(task: LiveTask, unitId: string): { subPath?: string | undefined } | undefined {
  const repoKey = task.state.units[unitId]?.repoKey;
  const repos = task.state.created?.repos ?? [];
  return repos.find((r) => r.repoKey === repoKey) ?? (repoKey ? undefined : repos[0]);
}

function chatBriefOf(task: LiveTask, s: StepCtx, cwd: string, inPlace: boolean): string {
  const session = task.state.created?.session;
  const own = session?.brief === 'none' ? '' : chatBrief(s, cwd, inPlace);
  return [own, session?.append?.trim() ?? ''].filter(Boolean).join('\n\n');
}

/**
 * Слой человека в сеансе: режимы шага, сужения вызывающего (G6) — снять навыки, сузить источники
 * настроек и встроенные инструменты, плагины набора. Включить то, что шаг снял, нечем: навыки
 * `off` шага остаются `off`. Умеет ли переходник остальное — суд дороги до запуска.
 */
function sessionLayer(task: LiveTask, s: StepCtx): RoadStart['layer'] {
  const session = task.state.created?.session;
  const carry = {
    ...(session?.settingSources ? { settingSources: [...session.settingSources] } : {}),
    ...(session?.plugins ? { plugins: [...session.plugins] } : {}),
    ...(session?.builtinTools ? { builtinTools: [...session.builtinTools] } : {}),
    ...(session?.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
    ...(session?.localLayer ? { localLayer: session.localLayer } : {}),
    // Хуки профиля чата панели (s12) — тем же путём: суд дороги и переходника решает, нести ли.
    ...(session?.hooks ? { hooks: session.hooks } : {}),
  };
  return {
    hooks: s.def.userLayer.hooks,
    skills: session?.skills === 'off' ? 'off' : s.def.userLayer.skills,
    ...(session?.sources === 'user' ? { sources: 'user' as const } : {}),
    ...(Object.keys(carry).length > 0 ? { carry } : {}),
  };
}

export type StartOutcome = { ok: true; start: RoadStart } | { ok: false; reason: string };

/** Запуск сессии шага из фактов журнала; отказ называет, чего не хватило. */
export function stepStart(input: StartInputs, s: StepCtx, sessionId: string): StartOutcome {
  const { task } = input;
  const tier = s.routing?.tier;
  if (!tier) return { ok: false, reason: 'step has no routing decision' };
  if (!tier.ok) return { ok: false, reason: `tier refused: ${tier.reasons.join('; ')}` };
  if (isScratchTask(task)) return askStart(input, s, sessionId, tier);
  // Копия — только разложенная крючком копии; своей ядро тут не делает (одна копия на единицу).
  // Чат на месте (грант человека на корень, Q1) идёт в самом корне проекта — копии у него нет.
  const inPlace = inPlaceRootOf(task, s.unitId);
  const placed = inPlace ? undefined : unitCopyOf(task, s.unitId);
  const cwd = inPlace ?? placed?.dir ?? s.copyDir;
  if (!cwd) return { ok: false, reason: `unit ${s.unitId} has no copy` };
  // Проект в подпапке репозитория: копия — всего репозитория, CLI идёт в той же подпапке копии
  // (его CLAUDE.md, MCP и транскрипт — там). Чат на месте уже стоит в подпапке (`inPlaceRootOf`).
  const subPath = inPlace ? undefined : unitRepoOf(task, s.unitId)?.subPath;
  const workDir = subPath ? projectRootOf({ path: cwd, subPath }) : undefined;
  // `null` — модель по умолчанию CLI: `--model` не передаётся, `modelAsked` в журнале — `null`;
  // маршрут с адресом без модели отказывает дорога, называя причину.
  const model = tier.model;
  // Аренда той же модели (`null` — модель по умолчанию CLI) и того же маршрута, ресурсы живы.
  const lease = journaledLease(task, tier.route.id, model);
  const unit = task.state.units[s.unitId];
  const resume = resumeOf(task, s, tier.adapter);
  return {
    ok: true,
    start: {
      task,
      stepId: s.stepId,
      stepKind: s.def.kind,
      adapterId: tier.adapter,
      routeId: tier.route.id,
      model,
      ...(tier.effort ? { effort: tier.effort } : {}),
      sessionId,
      dir: journaledSessionDir(task, sessionId),
      cwd,
      ...(workDir ? { workDir } : {}),
      brief:
        s.def.kind === 'chat'
          ? chatBriefOf(task, s, workDir ?? cwd, inPlace !== undefined)
          : systemBrief(s, cwd),
      deny: STEP_DENY,
      tools: toolPlanFor(s.def.kind)?.builtins ?? 'read-only',
      layer: sessionLayer(task, s),
      pin: sessionPin(input),
      ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
      ...(lease ? { lease } : {}),
      ...(unit ? { ownedPaths: unit.ownedPaths } : {}),
      ...(placed ? { sourceRepo: placed.repo } : inPlace ? { sourceRepo: inPlace } : {}),
      ...(resume ? { resume } : {}),
      ...(tier.alternatives.length > 0
        ? {
            alternatives: tier.alternatives.map((a) => ({
              adapterId: a.adapter,
              routeId: a.route.id,
              model,
            })),
          }
        : {}),
    },
  };
}

/**
 * Продолжение из решения `continuation` шага (03:150-155): `same-session` — новый запуск
 * возобновляет разговор прежней сессии (`--resume <корень разговора>`), дельта приходит первым
 * словом (`opening`). Разговор — только у того же переходника: решение уже судит смену маршрута,
 * а здесь — страховка последней границы, чужой CLI чужого разговора не продолжает.
 */
function resumeOf(task: LiveTask, s: StepCtx, adapter: string): RoadResume | null {
  const cont = s.routing?.continuation;
  if (cont?.mode !== 'same-session') return adoptedResumeOf(task, s);
  const prior = task.state.sessions[cont.sessionId];
  if (!prior || prior.adapter !== adapter) return null;
  const lines = readJournalLines(task.dir, task.taskId).lines;
  return {
    conversationId: conversationOf(lines, cont.sessionId),
    of: cont.sessionId,
    from: journaledSessionDir(task, cont.sessionId),
    cacheAgeMs: cont.numbers.cacheAgeMs,
  };
}

/**
 * Разговор, начатый не ядром (оценка `resume`, этап 10 F2): его продолжает ПЕРВАЯ сессия шага
 * чата — дальше разговор уже ядра, и его ведёт решение `continuation`. CLI в просьбе берётся как
 * есть, даже если шаг пошёл другим CLI: несовпадение — отказ дороги по имени, а не тихий новый
 * разговор. Подтверждает транскрипт только переходник (`adoptRefusal`), не этот id.
 */
function adoptedResumeOf(task: LiveTask, s: StepCtx): RoadResume | null {
  const asked = task.state.created?.resume;
  if (!asked || s.def.kind !== 'chat') return null;
  const began = Object.values(task.state.sessions).some((x) => x.stepId === s.stepId);
  if (began) return null;
  return { conversationId: asked.conversationId, adopt: { adapter: asked.adapter } };
}
