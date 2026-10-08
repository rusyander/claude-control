import type { Group } from '@agentdeck/contracts';
import {
  clampKnobRange,
  knobGrounded,
  knobId,
  knobSchema,
  MAX_KNOBS_PER_SKILL,
  mentionsNumber,
  type GroupKnobValues,
  type GroupKnobsView,
  type Knob,
  type KnobView,
} from '@agentdeck/contracts/group-knobs';
import { groupKeyOf, isForeignGlobal, type GroupScope } from '@agentdeck/contracts/group-sources';
import { projectKey, readPanelJson, writePanelJson } from '../../../lib/app-store/group-sources.ts';
import { readJsonBlock } from '../answer-block.ts';
import { badGroupRequest } from '../errors.ts';
import { knobCandidates } from '../knob-candidates/knob-candidates.ts';
import { knobStep } from '../knob-step/knob-step.ts';
import { memberContent, memberScope, type MemberDeps } from '../members/members.ts';
import { GroupModelError, singleTurn, type GroupAsk, type GroupModelMessage } from '../model.ts';

/**
 * «Числа» группы: сколько прогонов делают её скиллы-участники.
 *
 * Выписку из текста скилла делает дешёвая модель, но верим мы только тексту:
 * число без дословной цитаты, где оно стоит, отбрасывается (`knobGrounded`).
 * Кэш — `<appData>/skill-knobs.json` по хэшу каталога скилла: пока скилл не
 * менялся, повторный показ бесплатен. В тексте нет ни одной цифры — модель не
 * зовётся вовсе: выписать из него нечего.
 *
 * Пустой ответ при строках, похожих на счётчик (`knobCandidates`), — не «чисел
 * нет», а промах модели: она переспрашивается один раз строже, а если и тогда
 * пусто, в кэш ничего не ложится — неудача пишется в `skill-knobs-failed.json`
 * вместе с ответами модели, чтобы было видно, что она сказала.
 */

const FILE = 'skill-knobs.json';
const FAILED_FILE = 'skill-knobs-failed.json';
/**
 * Версия выписки. Запись другой версии — не кэш: скилл не менялся, а правила
 * выписки менялись (v2 — числа словами, v3 — строки-кандидаты и переспрос).
 * Без этого «пусто» от старых правил держалось бы, пока человек не правил скилл.
 */
export const KNOBS_EXTRACTION_VERSION = 3;
/** Сколько текста скилла видит выписка: счётчики стоят и в конце длинных скиллов. */
const KNOBS_TEXT_LIMIT = 48_000;
export const KNOBS_BLOCK_KIND = 'group-knobs';
/** Не удалось — повтор не раньше, чем через столько: иначе каждый показ платил бы заново. */
const RETRY_AFTER_MS = 10 * 60_000;
/** Потолок паузы после повторных пустых ответов: скилл, где счётчиков правда нет, не платит каждые 10 минут. */
const RETRY_CEILING_MS = 24 * 60 * 60_000;
/** Сколько символов ответа модели хранится для разбора неудачи. */
const REPLY_KEEP = 4_000;
export const KNOBS_EMPTY_REASON = 'knobs-empty';

interface CacheEntry {
  hash: string;
  knobs: Knob[];
  v?: number;
}

const fresh = (entry: CacheEntry | undefined, hash: string): entry is CacheEntry =>
  entry?.hash === hash && entry.v === KNOBS_EXTRACTION_VERSION;
/**
 * Запись прежней версии для того же текста скилла. Пока идёт новая выписка, она
 * показывается как есть: иначе смена правил выписки на время прятала бы уже
 * закреплённые числа группы. Скилл менялся (другой хэш) — старое не годится:
 * его цитат в тексте может уже не быть.
 */
const stale = (entry: CacheEntry | undefined, hash: string): entry is CacheEntry =>
  entry?.hash === hash && entry.v !== KNOBS_EXTRACTION_VERSION;
type Cache = Record<string, CacheEntry>;

/** Неудачная выписка: когда, сколько раз подряд и что ответила модель. */
interface FailureEntry {
  hash: string;
  v: number;
  at: number;
  /** Подряд пустых ответов при кандидатах; от них растёт пауза. Ошибка вызова — всегда 1. */
  count: number;
  reason: string;
  candidates?: string[];
  replies?: string[];
}
type Failures = Record<string, FailureEntry>;

const inFlight = new Map<string, Promise<Knob[]>>();

function readFailures(appData: string): Failures {
  return readPanelJson<Failures>(appData, FAILED_FILE, {});
}

function writeFailure(appData: string, key: string, entry: FailureEntry | undefined): void {
  const failures = readFailures(appData);
  if (!entry && !(key in failures)) return;
  if (entry) failures[key] = entry;
  else delete failures[key];
  writePanelJson(appData, FAILED_FILE, failures);
}

/** Пауза до следующей попытки: 10 минут, дальше вдвое за каждый пустой ответ, не больше суток. */
function retryAfter(failure: FailureEntry): number {
  return Math.min(RETRY_AFTER_MS * 2 ** Math.max(0, failure.count - 1), RETRY_CEILING_MS);
}

function backingOff(
  failure: FailureEntry | undefined,
  hash: string,
  now: number,
): failure is FailureEntry {
  return (
    failure?.hash === hash &&
    failure.v === KNOBS_EXTRACTION_VERSION &&
    now - failure.at < retryAfter(failure)
  );
}

function cacheKey(scope: GroupScope, skillId: string): string {
  const where = scope.kind === 'project' ? projectKey(scope.path) : 'global';
  return `${where}|skill:${skillId}`;
}

function readCache(appData: string): Cache {
  return readPanelJson<Cache>(appData, FILE, {});
}

/** Ответ модели → только обоснованные текстом числа, без повторов ключа, не больше потолка. */
export function groundedKnobs(skillId: string, raw: unknown, skillText: string): Knob[] {
  const list = (raw as { knobs?: unknown } | undefined)?.knobs;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const knobs: Knob[] = [];
  for (const item of list) {
    const parsed = knobSchema.omit({ skillId: true }).safeParse(item);
    if (!parsed.success || seen.has(parsed.data.key)) continue;
    if (!knobGrounded(parsed.data, skillText)) continue;
    seen.add(parsed.data.key);
    // Размах зажимается здесь: «max ≤ 4× умолчания» из промпта модель соблюдает
    // не всегда, а список ручки — пункт на каждое число.
    knobs.push(clampKnobRange({ ...parsed.data, skillId }));
    if (knobs.length >= MAX_KNOBS_PER_SKILL) break;
  }
  return knobs;
}

export interface SkillKnobsInput {
  deps: MemberDeps;
  ask: GroupAsk;
  /** Промпт каталога `group-knobs` с подставленным языком блока. */
  prompt: string;
  scope: GroupScope;
  skillId: string;
}

/**
 * Числа одного скилла: из кэша, если хэш тот же; иначе выписка моделью.
 * Скилла нет — `undefined`. Два одновременных запроса ждут один вызов.
 */
export async function skillKnobs(input: SkillKnobsInput): Promise<Knob[] | undefined> {
  const { deps, ask, prompt, scope, skillId } = input;
  const content = memberContent(deps, scope, { kind: 'skill', id: skillId });
  if (!content) return undefined;
  const appData = deps.paths.appData;
  const key = cacheKey(scope, skillId);
  const cached = readCache(appData)[key];
  if (fresh(cached, content.hash)) return cached.knobs;

  const flightKey = `${appData}|${key}|${content.hash}`;
  const pending = inFlight.get(flightKey);
  if (pending) return pending;

  const run = (async (): Promise<Knob[]> => {
    const result = mentionsNumber(content.text)
      ? await extractKnobs(ask, prompt, skillId, content.text)
      : { knobs: [], replies: [], candidates: [] };
    const previous = readFailures(appData)[key];
    if (result.knobs.length === 0 && result.candidates.length > 0) {
      // Кандидаты есть, а чисел нет и после переспроса — промах, не «чисел нет»:
      // в кэш не ложится, пауза растёт с каждым таким ответом подряд.
      const sameText = previous?.hash === content.hash && previous.v === KNOBS_EXTRACTION_VERSION;
      writeFailure(appData, key, {
        hash: content.hash,
        v: KNOBS_EXTRACTION_VERSION,
        at: Date.now(),
        count: sameText && previous.reason === KNOBS_EMPTY_REASON ? previous.count + 1 : 1,
        reason: KNOBS_EMPTY_REASON,
        candidates: result.candidates,
        replies: result.replies.map((reply) => reply.slice(0, REPLY_KEEP)),
      });
      throw new GroupModelError(KNOBS_EMPTY_REASON, `${skillId}: no knobs for run-count lines`);
    }
    // Перечитываем перед записью: пока шёл вызов, мог записаться соседний скилл.
    const cache = readCache(appData);
    cache[key] = { hash: content.hash, knobs: result.knobs, v: KNOBS_EXTRACTION_VERSION };
    writePanelJson(appData, FILE, cache);
    writeFailure(appData, key, undefined);
    return result.knobs;
  })();
  inFlight.set(flightKey, run);
  try {
    return await run;
  } catch (error) {
    if (!(error instanceof GroupModelError && error.reason === KNOBS_EMPTY_REASON)) {
      // Сбой вызова (сеть, вход, лимит) — пауза без роста: причину чинят снаружи.
      writeFailure(appData, key, {
        hash: content.hash,
        v: KNOBS_EXTRACTION_VERSION,
        at: Date.now(),
        count: 1,
        reason: error instanceof GroupModelError ? error.reason : 'call-failed',
      });
    }
    throw error;
  } finally {
    inFlight.delete(flightKey);
  }
}

interface Extraction {
  knobs: Knob[];
  replies: string[];
  candidates: string[];
}

/**
 * Переспрос, когда в тексте есть строки-счётчики, а ответ пуст. Идёт настройкой
 * провайдера, а не дешёвой ступенью: дешёвая уже промахнулась на этом тексте.
 */
function followUp(candidates: readonly string[]): string {
  return [
    'Your list has no number whose quote is in the skill text, yet these lines of it count runs:',
    ...candidates.map((line) => `- ${line}`),
    'For each line that says how many times or how many workers the skill runs something, give a',
    'number with its quote copied exactly from the skill text. Leave out a line only if its number',
    'is not such a count. Answer with exactly one code block as before, nothing after it.',
  ].join('\n');
}

async function extractKnobs(
  ask: GroupAsk,
  prompt: string,
  skillId: string,
  text: string,
): Promise<Extraction> {
  const candidates = knobCandidates(text);
  const hint =
    candidates.length > 0
      ? `\n\nLines that look like run counts:\n${candidates.map((line) => `- ${line}`).join('\n')}`
      : '';
  const messages: GroupModelMessage[] = singleTurn(
    prompt,
    `skill ${skillId}:\n${text.slice(0, KNOBS_TEXT_LIMIT)}${hint}`,
  );
  const first = await ask(messages, 'cheap');
  const knobs = groundedKnobs(skillId, readJsonBlock(first, KNOBS_BLOCK_KIND), text);
  if (knobs.length > 0 || candidates.length === 0) return { knobs, replies: [first], candidates };
  const retry: GroupModelMessage[] = [
    ...messages,
    { role: 'assistant', content: first },
    { role: 'user', content: followUp(candidates) },
  ];
  const second = await ask(retry, 'default');
  return {
    knobs: groundedKnobs(skillId, readJsonBlock(second, KNOBS_BLOCK_KIND), text),
    replies: [first, second],
    candidates,
  };
}

export interface GroupKnobsInput {
  deps: MemberDeps;
  ask: GroupAsk;
  prompt: string;
  group: Pick<Group, 'id' | 'scope' | 'members' | 'knobs'>;
  /** Неготовые скиллы: выписка идёт в фоне, ошибка — сюда, в журнал. */
  onError?: (error: unknown, skillId: string) => void;
  now?: () => number;
}

function viewOf(cached: Knob, values: GroupKnobValues | undefined, text: string): KnobView {
  // Кэш прежних выписок мог сохранить незажатый размах.
  const knob = clampKnobRange(cached);
  const own = values?.[knobId(knob)];
  const value = own ?? knob.default;
  const step = knobStep(text, knob.quote);
  return {
    ...knob,
    value,
    auto: own === undefined,
    overridden: value !== knob.default,
    ...(step === undefined ? {} : { step }),
  };
}

/**
 * Числа группы. Отвечает сразу: готовое — из кэша, скилл без цифр — пустым,
 * остальное уходит в фон и называется в `pending`; следующий запрос его уже
 * получит. Недавняя неудача не повторяется на каждом показе и называется в
 * `failed`, а не «читается» без конца.
 */
export function groupKnobsView(input: GroupKnobsInput): GroupKnobsView {
  const { deps, ask, prompt, group } = input;
  const now = input.now ?? Date.now;
  const cache = readCache(deps.paths.appData);
  const failures = readFailures(deps.paths.appData);
  const knobs: KnobView[] = [];
  const pending: string[] = [];
  const failed: string[] = [];
  for (const member of group.members) {
    if (member.kind !== 'skill') continue;
    const scope = memberScope(group, member);
    // Скилл копии для другой CLI лежит в её каталогах; одноимённый скилл Claude —
    // другой файл, и выписка из него (с вызовом модели) дала бы чужие числа.
    if (isForeignGlobal(scope)) continue;
    const content = memberContent(deps, scope, member);
    if (!content) continue;
    const key = cacheKey(scope, member.id);
    const cached: CacheEntry | undefined = cache[key];
    // Отдельная ссылка на ту же запись: отрицательная ветка охранника `fresh`
    // сужает `cached` до undefined, и `stale` на нём был бы never.
    const previous: CacheEntry | undefined = cached;
    if (fresh(cached, content.hash)) {
      knobs.push(...cached.knobs.map((knob) => viewOf(knob, group.knobs, content.text)));
      continue;
    }
    if (stale(previous, content.hash)) {
      knobs.push(...previous.knobs.map((knob) => viewOf(knob, group.knobs, content.text)));
    }
    if (!mentionsNumber(content.text)) continue;
    if (backingOff(failures[key], content.hash, now())) {
      failed.push(member.id);
      continue;
    }
    pending.push(member.id);
    skillKnobs({ deps, ask, prompt, scope, skillId: member.id }).catch((error: unknown) =>
      input.onError?.(error, member.id),
    );
  }
  return {
    groupId: group.id,
    knobs,
    ...(pending.length > 0 ? { pending } : {}),
    ...(failed.length > 0 ? { failed } : {}),
  };
}

/**
 * Новые значения группы. Число вне границ или неизвестное — отказ 400; `null`
 * убирает запись — число снова «Авто». Число, равное умолчанию скилла,
 * хранится: закреплённое умолчание — не «Авто», скилл обязан взять ровно его.
 * Не названные в правке значения остаются как были — в том числе у скиллов,
 * чья выписка ещё не готова.
 */
export function applyKnobsEdit(
  known: readonly Knob[],
  current: GroupKnobValues | undefined,
  values: Record<string, number | null>,
): GroupKnobValues {
  const next: GroupKnobValues = { ...current };
  for (const [id, value] of Object.entries(values)) {
    const knob = known.find((item) => knobId(item) === id);
    if (!knob) throw badGroupRequest(`${id}: unknown`);
    if (value === null) {
      delete next[id];
      continue;
    }
    if (value < knob.min || value > knob.max) {
      throw badGroupRequest(`${id}: ${knob.min}..${knob.max}`);
    }
    next[id] = value;
  }
  return next;
}

/**
 * Строка прогона: все закреплённые числа — и равные умолчанию скилла тоже, —
 * по-английски, одной строкой. «Авто» в неё не попадает: там скилл решает сам.
 * Зависит лишь от группы и её значений (метки и умолчания — из кэша, без
 * хэширования скилла на каждом ходу), поэтому одинакова от хода к ходу и не
 * ломает подпись живого процесса. Ничего не закреплено — `undefined`.
 */
export function groupKnobsLine(
  appData: string,
  group: Pick<Group, 'name' | 'scope' | 'members' | 'knobs'>,
): string | undefined {
  const values = group.knobs;
  if (!values || Object.keys(values).length === 0) return undefined;
  const cache = readCache(appData);
  const parts: string[] = [];
  for (const id of Object.keys(values).sort()) {
    const cut = id.lastIndexOf(':');
    const skillId = id.slice(0, cut);
    const key = id.slice(cut + 1);
    const member = group.members.find((item) => item.kind === 'skill' && item.id === skillId);
    if (!member) continue;
    const knob = cache[cacheKey(memberScope(group, member), skillId)]?.knobs.find(
      (item) => item.key === key,
    );
    const value = values[id];
    if (!knob || value === undefined) continue;
    parts.push(`${skillId} — ${knob.label.en}: ${value} (skill default ${knob.default})`);
  }
  if (parts.length === 0) return undefined;
  return (
    `The group "${group.name}" sets these run counts for its skills: ${parts.join('; ')}. ` +
    'Use exactly these counts on every run without asking the user; ask only if the task is ' +
    'critical and these counts clearly do not fit it.'
  );
}

/** Строка чисел группы, выбранной в чате (`groupChoice`); «авто» и чужой ключ — ничего. */
export function knobsLineForChoice(
  appData: string,
  groups: readonly Group[],
  choice: string,
): string | undefined {
  if (choice === 'auto') return undefined;
  const group = groups.find((item) => groupKeyOf(item) === choice);
  // Копия для другой CLI Claude-прогону чисел не задаёт: её скиллы — не его.
  return group && !isForeignGlobal(group.scope) ? groupKnobsLine(appData, group) : undefined;
}

/**
 * Числа копии группы: только у скиллов, дошедших до цели (`renames` — откуда →
 * куда), и под НОВЫМ id скилла, если копия его переименовала. Число скилла,
 * которого у копии нет, не везётся: у неё его некому применить.
 */
export function carriedKnobs(
  values: GroupKnobValues | undefined,
  renames: ReadonlyMap<string, string>,
): GroupKnobValues | undefined {
  if (!values) return undefined;
  const next: GroupKnobValues = {};
  for (const [id, value] of Object.entries(values)) {
    const cut = id.lastIndexOf(':');
    const to = renames.get(id.slice(0, cut));
    if (to) next[`${to}${id.slice(cut)}`] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Выписка скилла-оригинала — копии, чтобы привезённые значения нашли свои числа
 * сразу. Без этого копия ждала бы новой выписки моделью, а та вправе назвать
 * ключи иначе: значения группы молча перестали бы действовать. Свежей выписки
 * у оригинала нет или у цели уже своя — ничего не пишется; число, чьей цитаты
 * в тексте копии нет, не переносится.
 */
export function seedCopiedKnobs(
  deps: MemberDeps,
  from: { scope: GroupScope; skillId: string },
  to: { scope: GroupScope; skillId: string },
): void {
  const source = memberContent(deps, from.scope, { kind: 'skill', id: from.skillId });
  const target = memberContent(deps, to.scope, { kind: 'skill', id: to.skillId });
  if (!source || !target) return;
  const cache = readCache(deps.paths.appData);
  const own = cache[cacheKey(from.scope, from.skillId)];
  if (!fresh(own, source.hash)) return;
  const key = cacheKey(to.scope, to.skillId);
  if (fresh(cache[key], target.hash)) return;
  cache[key] = {
    hash: target.hash,
    v: KNOBS_EXTRACTION_VERSION,
    knobs: own.knobs
      .filter((knob) => knobGrounded(knob, target.text))
      .map((knob) => ({ ...knob, skillId: to.skillId })),
  };
  writePanelJson(deps.paths.appData, FILE, cache);
}
