import type { SignalId } from '@agentdeck/contracts/core/signal-view';
import type {
  HintFact,
  SignalDef,
  SignalLevel,
  SignalSelftest,
  SignalSeverity,
} from './observer.types.ts';

/**
 * Каталог сигналов ядра (этап 8, F12, P33): у каждого id, который ядро пишет в строку `signal`,
 * — серьёзность, действие для дирижёра, владелец, точка человека, порог ложных и самопроверка.
 * Сигналы, которые пишут их владельцы по своему правилу (`emitted`), занесены с той серьёзностью,
 * с какой их пишут сегодня; предикаты наблюдателя (`predicate`) — по 06 §Observer. Строка без
 * каталога — неизвестный сигнал: наблюдатель его не судит. Полноту держит `catalog.test.ts`:
 * поиск по коду находит каждую запись сигнала и каждый вердикт, и id без строки здесь краснеет.
 * Точка человека — `null` у всех на этапе 8 (P96: сигнал сам человека не зовёт); порог ложных 0
 * (F13: ложное срабатывание на библиотеке заглушек — дефект, а не статистика).
 */

const SHOW: SignalLevel['action'] = 'show';

/**
 * Сигнал, который пишет его владелец. Действие — то, что сегодня выводится из серьёзности
 * строки без поля `action`: `stop` снимает шаг, прочее только показано.
 */
const SEVERITY_ORDER: readonly SignalSeverity[] = ['stop', 'warn', 'info'];

/** Тест, где сигнал выходит: путь от `apps/core/src` и полный путь vitest «describe > it». */
function test(file: string, fires: string, silent: string | null = null): SignalSelftest {
  return { file, fires, silent };
}

function emitted(
  id: SignalId,
  owner: string,
  severities: readonly SignalSeverity[],
  selftest: SignalSelftest | null,
): SignalDef {
  // Старшая из написанных: по ней судит `judgeSignal`, если сигнал когда-то пойдёт через него.
  const severity = SEVERITY_ORDER.find((s) => severities.includes(s)) ?? 'info';
  return {
    id,
    kind: 'emitted',
    owner,
    severities,
    severity,
    action: severity === 'stop' ? 'stop-step' : SHOW,
    humanPoint: null,
    fpThreshold: 0,
    selftest,
  };
}

interface PredicateRow {
  id: SignalId;
  owner: string;
  first: SignalLevel;
  escalated?: SignalLevel;
  hint?: (fact: HintFact) => string;
  /** Пара предиката обязана иметь и почти-двойника (`silent`); `null` — зона ещё не сдала. */
  selftest: SignalSelftest | null;
}

function predicate(row: PredicateRow): SignalDef {
  const severities = [row.first.severity, ...(row.escalated ? [row.escalated.severity] : [])];
  return {
    id: row.id,
    kind: 'predicate',
    owner: row.owner,
    severities: [...new Set(severities)],
    ...row.first,
    ...(row.escalated ? { escalated: row.escalated } : {}),
    humanPoint: null,
    fpThreshold: 0,
    selftest: row.selftest,
    ...(row.hint ? { hint: row.hint } : {}),
  };
}

const HINT: SignalLevel = { severity: 'warn', action: 'hint' };
const STOP: SignalLevel = { severity: 'stop', action: 'stop-step' };

const ESTIMATE_ROUTE = test(
  'api/estimate.integration.test.ts',
  'estimate route > G5 P101 authority first, then repos, then preflight: 202 estimating with unit 0, replay 200 same task',
);
const HOOK_TAP = 'bootstrap/user-layer-wiring/tap.test.ts';
const STEP_DONE = test(
  'conductor/model-tools/step-done.test.ts',
  'step_done evidence binding > G3 a claim citing an id the core never issued is a field error; P72 call errors are listed once, then counted; P08 an evidence refusal is never counted',
);
const SERVED = test(
  'bootstrap/economy-wiring/served.test.ts',
  'stage 8 journalServed goes through the observer judge > another model than asked → model-served, then decision{observer, key} and route-mismatch with cause',
);

/**
 * Сигналы, которые пишут их владельцы, — владелец и серьёзность как в коде. Самопроверка `null` —
 * ни один тест ядра этот id сегодня не проверяет (назван в отчёте зоны I, `catalog.test`
 * держит их список: новый тест обязан попасть сюда, а не остаться незамеченным).
 */
const EMITTED: SignalDef[] = [
  emitted('preflight', 'conductor/estimate/preflight-run', ['info', 'stop'], ESTIMATE_ROUTE),
  emitted(
    'ask-reminder',
    'conductor/human/upkeep',
    ['info', 'warn'],
    test(
      'conductor/human/upkeep.test.ts',
      'ask upkeep > reminds a blocking ask at 15 min, 1 h and 4 h, then never again; the ask never expires',
    ),
  ),
  emitted(
    'ask-refused',
    'conductor/ask/ask',
    ['warn'],
    test(
      'api/ask.api.test.ts',
      'POST /v1/ask: proof of a human, refusals journaled (stage 10 F2, P41/P97) > an adapter outside the allowed set is a 422: the task fails at once and its bridge token is dropped',
    ),
  ),
  emitted(
    'mcp-human',
    'bootstrap/session-road/road',
    ['info'],
    test(
      'bootstrap/session-road/mcp-human.integration.test.ts',
      'session road: panel chat gets the human servers by default (s10 p8, old chat parity) > a present mcpPicks.chat is exact: [] = none, [picked] = only it; other kinds stay explicit',
    ),
  ),
  emitted(
    'estimate-refused',
    'conductor/estimate/estimate',
    ['stop'],
    test(
      'bootstrap/boot.split-env.test.ts',
      'boot: split env reaches the API > a booted core answers /v1/estimate with the split env of its conductor: a missing repo is 422 estimate-refused, not 501 not-wired',
    ),
  ),
  emitted('base-pin', 'conductor/estimate/estimate', ['info', 'warn'], ESTIMATE_ROUTE),
  emitted(
    'user-layer-report',
    'conductor/estimate/estimate',
    ['info', 'warn'],
    test(
      'conductor/estimate/estimate.user-layer.test.ts',
      'G-h estimate user layer report and grants (conductor/estimate) > P36 guard: the journal with lint warnings equals the one without, except the report line itself',
    ),
  ),
  emitted(
    'estimate-history',
    'conductor/estimate/estimate',
    ['info'],
    test(
      'conductor/estimate/estimate.test.ts',
      'estimate numbers from history (03:157) > median and [p10, p90] of past tasks of the scenario; cancelled ones do not count; the replay answers the same numbers after history grew',
    ),
  ),
  // Правка вне своих путей: судья допуска (`policy/permit`), пишут дорога хука, инструмент модели и деление.
  emitted(
    'ownership',
    'policy/permit',
    ['warn'],
    test(
      'conductor/model-tools/permit-call.test.ts',
      'agentdeck-permit > a denied edit renders the CLI deny form; an edit outside owned paths is allowed with an ownership signal',
    ),
  ),
  emitted(
    'forged-authority',
    'policy/authority',
    ['stop'],
    test(
      'api/commands.authority.test.ts',
      'POST /v1/commands: authority before the task opens > F-47 a session token on an unfinished task this core does not hold: 403 forged-authority without opening it',
    ),
  ),
  emitted('step-done-refused', 'conductor/model-tools/step-done', ['warn'], STEP_DONE),
  emitted('step-done-invalid', 'conductor/model-tools/step-done', ['info', 'warn'], STEP_DONE),
  emitted(
    'step-blocker',
    'conductor/model-tools/model-tools',
    ['warn'],
    test(
      'conductor/model-tools/model-tools.test.ts',
      'model tools > human-point items by typed action: user path classes, grantRequired, tracker writes, access blockers',
    ),
  ),
  emitted('model-served', 'bootstrap/economy-wiring/served', ['info'], SERVED),
  emitted(
    'route-mismatch',
    'observer/route-mismatch',
    ['warn'],
    test(
      'observer/route-mismatch.test.ts',
      'P119 route-mismatch judge (observer) > another model than asked fires a warn route-mismatch with action show, naming route, asked and served',
    ),
  ),
  emitted(
    'profile-moved',
    'bootstrap/conductor-wiring/wiring',
    ['warn'],
    test(
      'bootstrap/conductor-wiring/wiring.integration.test.ts',
      'step wiring of zone F on a real repo, copy, verifier and journal > profile moved against the pin: one profile-moved signal per new fingerprint, a brief section every step, the registry stays pinned',
    ),
  ),
  emitted(
    'context-drift',
    'bootstrap/economy-wiring/context',
    ['warn'],
    test(
      'bootstrap/economy-wiring/context.test.ts',
      'createContextWiring.base and drift > first usage beyond 20 % raises context-drift and forgets the base; later turns are not judged',
    ),
  ),
  emitted(
    'forged-publish',
    'observer/forged-publish',
    ['warn', 'stop'],
    test(
      'bootstrap/conductor-wiring/guard.integration.test.ts',
      'guard hooks > a bypass push lands on the remote → forged-publish stops the step',
    ),
  ),
  emitted(
    'hook-block',
    'observer/hook-block',
    ['warn'],
    test(
      HOOK_TAP,
      'G-e user layer tap (session runtime → journal) > a named refusal journals an observer decision and a warn hook-block naming hook, tool and event',
    ),
  ),
  emitted(
    'hook-loop',
    'observer/hook-loop',
    ['stop'],
    test(
      HOOK_TAP,
      'G-e user layer tap (session runtime → journal) > the same refusal 3x in one step adds a stop hook-loop that lands in step.stops; another target does not count',
    ),
  ),
  emitted(
    'keep-warm',
    'conductor/run/run',
    ['info'],
    test(
      'conductor/run/run.economy.test.ts',
      'conductor loop: economy (stage 5 W) > G8 keep-warm execution: the economy port picks idle sessions, the loop sends its word once, journals the numbers, a session mid-ping is not offered again',
    ),
  ),
  emitted(
    'session-refused',
    'conductor/run/perform',
    ['warn'],
    test(
      'bootstrap/conductor-wiring/session-refused.loop.integration.test.ts',
      'Q1: a road refusal of openSession is journaled and reaches point 6 on the booted loop > route without a named model: each refusal is a task-journal signal, the 3rd ends the step no-outcome, the fresh attempt the same, then point 6 asks the human',
    ),
  ),
  emitted(
    'resume-refused',
    'bootstrap/session-road/road',
    ['warn'],
    test(
      'bootstrap/session-road.adopt.integration.test.ts',
      'adopting an outside CLI conversation through the real session road (stage 10 F2) > a forged id the CLI store does not hold is refused resume_not_owned before any process',
    ),
  ),
  emitted(
    'chat-in-place',
    'bootstrap/conductor-wiring/wiring',
    ['info'],
    test(
      'bootstrap/conductor-wiring/wiring.in-place.integration.test.ts',
      'panel chat in place: the chat start is the grant for the root (Q1) > unit start lays no copy and names the root once; the final gate builds nothing over a copy',
    ),
  ),
  emitted(
    'read-allow-unread',
    'bootstrap/session-road/road',
    ['warn'],
    test(
      'bootstrap/session-road/read-scope-signals.test.ts',
      'read scope signals through the real session road > read-allow-unread: a readAllow section that fails the schema is a warn signal naming the config, and the list stays empty',
    ),
  ),
  emitted(
    'read-scope-refused',
    'bootstrap/session-road/road',
    ['info'],
    test(
      'bootstrap/session-road/read-scope-signals.test.ts',
      'read scope signals through the real session road > read-scope-refused: an entry the builder cannot accept is an info signal naming it; the accepted entries stay',
    ),
  ),
  emitted(
    'permit-sources-unread',
    'bootstrap/session-road/road',
    ['warn'],
    test(
      'bootstrap/session-road/permit-sources.test.ts',
      'P130 through the real session road > an unreadable grantRequired entry is named by a signal, not skipped silently',
    ),
  ),
  emitted(
    'capture-roads',
    'bootstrap/session-road/capture-roads',
    ['info', 'warn'],
    test(
      'bootstrap/session-road/hook-file.test.ts',
      'container wrapper files (P58) > capture-roads signal: a found tool whose wrapper failed is warn and named NOT captured, not listed as absent (B2r6-F04)',
    ),
  ),
  emitted(
    'resources-unread',
    'bootstrap/session-road/resources',
    ['warn'],
    test(
      'bootstrap/session-road/resources-unread.test.ts',
      'an unread step-end resource scan reaches the task journal and task end (A2r5-F05) > silent engine at session stop → signal resources-unread in the journal, TaskRelease.unread names it',
    ),
  ),
  emitted(
    'protected-root-unread',
    'bootstrap/session-road/protected-roots',
    ['warn', 'stop'],
    test(
      'bootstrap/session-road/protected-roots.test.ts',
      'P04 protected roots at step end (real git repo, real config dir) > unreadable root → unknown + protected-root-unread warn, never "nothing changed"',
    ),
  ),
  emitted(
    'protected-root',
    'bootstrap/session-road/protected-roots',
    ['stop'],
    test(
      'bootstrap/session-road/protected-roots.test.ts',
      'P04 protected roots at step end (real git repo, real config dir) > destructive effects outside the copy → one stop signal per path',
    ),
  ),
  emitted(
    'route-lease',
    'bootstrap/session-road/lease-release',
    ['info'],
    test(
      'bootstrap/session-road.integration.test.ts',
      'session road: one entry from compat to resource release > a task end releases the route lease the road took — of a launched session and of a launch that never came — read back, once',
    ),
  ),
  emitted(
    'layer-loss',
    'bootstrap/session-road/layer-journal',
    ['warn'],
    test(
      'bootstrap/session-road/layer-journal.test.ts',
      'journalLayerStart > each loss is a warn layer-loss signal; observe opens an empty hooks log, off does not',
    ),
  ),
  emitted(
    'session-snapshot',
    'bootstrap/session-road/core-state',
    ['info'],
    test(
      'bootstrap/session-road/core-state.test.ts',
      'core session snapshots > session-snapshot: writing a snapshot journals an info signal with its sha256 digest, and the read returns the value',
    ),
  ),
  // Отвергнутую строку в журнале не сложить свёрткой — сигнал выносит проводка из крючка писателя.
  emitted(
    'journal-rejected',
    'observer/integrity/journal-rejected',
    ['warn'],
    test(
      'bootstrap/observer-wiring/integrity.test.ts',
      'journal-rejected sink > a refused line in the real writer becomes decision + warn journal-rejected naming its kind',
      'journal-rejected sink > a refused signal row of the sink itself is noted, never journaled again',
    ),
  ),
];

const INTEGRITY_TEST = 'observer/integrity/integrity.test.ts';
const WASTE_TEST = 'observer/waste/waste.test.ts';
const WASTE = 'stage 8 waste predicates (observer fold)';
const STALL = 'stage 8 stall predicate over session.probe (F9, P18)';

/**
 * Предикаты этапа 8 (06:134-145): логику строят зоны W (waste), T (stall), I (integrity).
 * Подсказки — английский текст для модели, без прозы из её же вывода (P32).
 */
const PREDICATES: SignalDef[] = [
  predicate({
    id: 'waste-reread',
    owner: 'observer/waste',
    first: HINT,
    hint: (f) =>
      `You already read ${f.subject} in this session and it has not changed since. Use what you read instead of reading it again.`,
    selftest: test(
      WASTE_TEST,
      `${WASTE} > waste-reread > fires once per path and fingerprint, on the second covered read, with step and session`,
      `${WASTE} > waste-reread > a window not covered by earlier windows is no reread; a whole read covers any window`,
    ),
  }),
  predicate({
    id: 'waste-big-read',
    owner: 'observer/waste',
    first: HINT,
    hint: (f) =>
      `${f.subject} is large and was read whole. Read only the part you need (offset/limit) or search it first.`,
    selftest: test(
      WASTE_TEST,
      `${WASTE} > waste-big-read > fires above 30 KiB read whole only; a window, an error or an unknown size is silent`,
      `${WASTE} > waste-big-read > fires above 30 KiB read whole only; a window, an error or an unknown size is silent`,
    ),
  }),
  predicate({
    id: 'waste-fail-repeat',
    owner: 'observer/waste',
    first: HINT,
    escalated: STOP,
    hint: (f) =>
      `The command \`${f.subject}\` failed the same way again with no edit in between. Change something before running it again.`,
    selftest: test(
      WASTE_TEST,
      `${WASTE} > waste-fail-repeat > second same failure is a hint, third escalates to stop, fourth adds nothing`,
      `${WASTE} > waste-fail-repeat > an edit in the session or a success in the same directory resets the count`,
    ),
  }),
  predicate({
    id: 'waste-poll',
    owner: 'observer/waste',
    first: HINT,
    escalated: STOP,
    hint: () =>
      'You are waiting in a loop (sleep/poll) with nothing else happening. Stop polling; wait for the result or do other work.',
    selftest: test(
      WASTE_TEST,
      `${WASTE} > waste-poll > second wait in a row is a hint, the fourth escalates to stop`,
      `${WASTE} > waste-poll > any other call in the session or a turn the CLI started itself breaks the run`,
    ),
  }),
  predicate({
    id: 'waste-refusal-repeat',
    owner: 'observer/waste',
    first: STOP,
    selftest: test(
      WASTE_TEST,
      `${WASTE} > waste-refusal-repeat > the second refusal of the same step, action, target and code stops; a human point is never counted`,
      `${WASTE} > waste-refusal-repeat > one call refused on two roads counts once: by tool-use id, or within 2 s when an id is missing`,
    ),
  }),
  predicate({
    id: 'context-growth',
    owner: 'observer/integrity',
    first: { severity: 'warn', action: 'pause-at-safe-point' },
    selftest: test(
      INTEGRITY_TEST,
      'integrity context-growth predicate > main-session context past 60 % of the route window fires once, on the step of the session',
      'integrity context-growth predicate > near-miss: the same ramp stopping at 55 % stays silent',
    ),
  }),
  predicate({
    id: 'stall',
    owner: 'observer/stall',
    first: { severity: 'warn', action: SHOW },
    selftest: test(
      'observer/stall/stall.test.ts',
      `${STALL} > stage 8 stall predicate: an alive quiet session is shown with its quiet time, threshold, class and CPU; key per session and probe line`,
      `${STALL} > stage 8 stall near-miss: lines other than session.probe never fire, the registry carries the predicate, the catalog shows it without stopping`,
    ),
  }),
  predicate({
    id: 'resource-leak',
    owner: 'observer/integrity',
    first: { severity: 'warn', action: SHOW },
    selftest: test(
      INTEGRITY_TEST,
      'integrity resource-leak predicate > a resource.leak row fires one resource-leak naming the rid',
      'integrity resource-leak predicate > near-miss: the same resource released and verified gone stays silent',
    ),
  }),
  // Переход окна в `warn` — видимость (`info`), в держащий вердикт — тревога (`warn`, 03:157).
  predicate({
    id: 'window',
    owner: 'observer/integrity',
    first: { severity: 'info', action: SHOW },
    escalated: { severity: 'warn', action: SHOW },
    selftest: test(
      INTEGRITY_TEST,
      'integrity window predicate > open → warn is the first step, warn → refused escalates; one signal per transition',
      'integrity window predicate > near-miss: the same verdict again with only a new reset time stays silent',
    ),
  }),
];

export const SIGNAL_CATALOG: readonly SignalDef[] = [...EMITTED, ...PREDICATES];

const BY_ID = new Map<string, SignalDef>(SIGNAL_CATALOG.map((d) => [d.id, d]));

/** Строка каталога по id; `undefined` — сигнала в каталоге нет (наблюдатель его не судит). */
export function signalDef(id: string): SignalDef | undefined {
  return BY_ID.get(id);
}
