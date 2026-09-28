import type {
  DiscoveryErrorCode,
  DiscoveredGroup,
  DiscoverySourceResult,
  DiscoveryView,
} from '@agentdeck/contracts/group-sources';
import { discoveredGroupSchema } from '@agentdeck/contracts/group-sources';
import {
  projectKey,
  readPanelJson,
  updateGroupSources,
  writePanelJson,
} from '../../lib/app-store/group-sources.ts';
import { slugify } from '../../lib/slug.ts';
import { CLI_TIMEOUT_ERROR } from '../assistant-runner/cli.ts';
import { readJsonLoose } from '../groups/answer-block.ts';
import { singleTurn, type GroupAsk } from '../groups/model.ts';
import {
  chunkInventory,
  inventoryHash,
  inventoryText,
  readInventory,
  type InventoryItem,
} from './inventory.ts';
import type { DiscoverySpec } from './sources.ts';

/**
 * Прогон обнаружения: опись каждого источника без модели, затем ОДИН дешёвый
 * вызов на источник, чья опись сменилась с прошлого раза. Итог кэшируется по
 * хэшу описи в `<appData>/group-discovery.json`: повторный заход бесплатен,
 * пока в файлах ничего не поменялось.
 *
 * Состояние хода живёт в памяти (одно на каталог данных): страница опрашивает
 * GET, а два одновременных «Запустить» не должны звать модель дважды.
 */

export const DISCOVERY_FILE = 'group-discovery.json';
export const DISCOVERY_BLOCK_KIND = 'group-discover';
const CONCURRENCY = 2;
/** Меньше двух предметов — набора не бывает, модель не зовём. */
const MIN_ITEMS = 2;

interface CachedSource {
  inventoryHash: string;
  groups: DiscoveredGroup[];
  at: string;
  error?: string;
  /**
   * Вид ответа, по которому записаны находки. Меньше `TEXT_VERSION` (или нет) —
   * находки без второго языка: источник спрашивается заново, хоть опись и та же.
   */
  textVersion?: number;
}

/** 2 — имя, «Когда» и «почему» приходят на двух языках (`localized`). */
const TEXT_VERSION = 2;

/**
 * Поле ответа модели: пара `{ru, en}` или строка старого вида. Строка —
 * запасная сторона: английская, иначе русская.
 */
function answerText(value: unknown): { plain: string; pair?: { ru: string; en: string } } {
  if (typeof value === 'string') return { plain: value.trim() };
  if (!value || typeof value !== 'object') return { plain: '' };
  const { ru, en } = value as { ru?: unknown; en?: unknown };
  const pair = {
    ru: typeof ru === 'string' ? ru.trim() : '',
    en: typeof en === 'string' ? en.trim() : '',
  };
  return { plain: pair.en || pair.ru, pair };
}

export interface DiscoveryCache {
  version: 1;
  lastRunAt?: string;
  sources: Record<string, CachedSource>;
}

export function readDiscoveryCache(appData: string): DiscoveryCache {
  const raw = readPanelJson<Partial<DiscoveryCache>>(appData, DISCOVERY_FILE, {});
  return {
    version: 1,
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : undefined,
    sources: raw.sources && typeof raw.sources === 'object' ? raw.sources : {},
  };
}

/**
 * Записи кэша под старым написанием пути (`c:/…` и `C:/…`, обратные слэши) —
 * к ключу живого источника: один проект — одна запись. Запись уезжает с
 * находками (их ключи и `foundIn` переписываются, импорт в group-sources.json
 * тоже); уже есть запись под верным ключом — старая выбрасывается, а не
 * дублирует её. Возвращает, было ли что менять.
 */
export function settleCacheKeys(
  cache: DiscoveryCache,
  specs: readonly Pick<DiscoverySpec, 'source'>[],
): Map<string, string> | undefined {
  const live = new Map(specs.map((spec) => [projectKey(spec.source), spec.source]));
  const renamed = new Map<string, string>();
  let changed = false;
  for (const source of Object.keys(cache.sources)) {
    const target = live.get(projectKey(source));
    if (!target || target === source) continue;
    const entry = cache.sources[source]!;
    delete cache.sources[source];
    changed = true;
    const moved = entry.groups.map((group) => {
      const key = group.key.startsWith(source)
        ? target + group.key.slice(source.length)
        : group.key;
      // Ключ импорта переезжает и у выброшенного дубля: иначе импорт под
      // старым написанием сиротел, и повторный импорт заводил вторую группу (F-184).
      renamed.set(group.key, key);
      return { ...group, key, foundIn: target };
    });
    if (cache.sources[target]) continue;
    cache.sources[target] = { ...entry, groups: moved };
  }
  return changed ? renamed : undefined;
}

/** Кэш с устоявшимися ключами; переезд записывается сразу — и кэш, и импорт. */
function settledCache(appData: string, specs: readonly DiscoverySpec[]): DiscoveryCache {
  const cache = readDiscoveryCache(appData);
  const renamed = settleCacheKeys(cache, specs);
  if (!renamed) return cache;
  writePanelJson(appData, DISCOVERY_FILE, cache);
  if (renamed.size > 0) {
    updateGroupSources(appData, (state) => {
      for (const [from, to] of renamed) {
        const id = state.imported[from];
        if (id === undefined) continue;
        delete state.imported[from];
        state.imported[to] ??= id;
      }
    });
  }
  return cache;
}

interface RunState {
  running: boolean;
  sources: DiscoverySourceResult[];
  done?: Promise<void>;
}

const runs = new Map<string, RunState>();

export function runStateOf(appData: string): RunState | undefined {
  return runs.get(appData);
}

/** Ответ модели → находки, только из предметов описи и с их id как есть. */
export function parseProposal(
  reply: string,
  spec: Pick<DiscoverySpec, 'source'>,
  items: readonly InventoryItem[],
  hash: string,
  seenKeys: Set<string> = new Set(),
): DiscoveredGroup[] | undefined {
  const parsed = readJsonLoose(reply, DISCOVERY_BLOCK_KIND, 'groups');
  if (!parsed || !Array.isArray(parsed.groups)) return undefined;
  const byKey = new Map(items.map((item) => [`${item.kind}:${item.id}`, item]));
  const found: DiscoveredGroup[] = [];

  for (const raw of parsed.groups as Record<string, unknown>[]) {
    if (!raw) continue;
    const name = answerText(raw.name);
    if (!name.plain) continue;
    const when = answerText(raw.when);
    const why = answerText(raw.why);
    const members = (Array.isArray(raw.members) ? raw.members : [])
      .map((member: { kind?: unknown; id?: unknown }) =>
        byKey.get(`${String(member?.kind)}:${String(member?.id)}`),
      )
      .filter((item): item is InventoryItem => item !== undefined);
    // Набор, в котором модель не назвала ни одного настоящего предмета, — выдумка.
    if (members.length === 0) continue;
    const memberIds = new Set(members.map((item) => item.id));
    const steps = (Array.isArray(raw.steps) ? raw.steps : [])
      .filter(
        (step: { title?: unknown; source?: unknown }) =>
          typeof step?.title === 'string' && step.title.trim(),
      )
      .map((step: { title: string; source?: unknown }) => ({
        title: step.title.trim(),
        source: typeof step.source === 'string' && memberIds.has(step.source) ? step.source : '',
      }));

    let key = `${spec.source}#${slugify(name.plain) || 'group'}`;
    // Суффикс — от того же слага с запасным `group`: у имени без латиницы
    // иначе выходил ключ `<источник>#-2` (F-187).
    for (let n = 2; seenKeys.has(key); n += 1) {
      key = `${spec.source}#${slugify(name.plain) || 'group'}-${n}`;
    }
    seenKeys.add(key);

    const candidate = discoveredGroupSchema.safeParse({
      key,
      name: name.plain,
      when: when.plain,
      why: why.plain,
      ...(name.pair
        ? {
            localized: {
              name: name.pair,
              when: when.pair ?? { ru: when.plain, en: when.plain },
              why: why.pair ?? { ru: why.plain, en: why.plain },
            },
          }
        : {}),
      foundIn: spec.source,
      usedIn: [],
      members: members.map((item) => ({
        kind: item.kind,
        id: item.id,
        path: item.path,
        summary: item.summary,
      })),
      steps,
      inventoryHash: hash,
      status: 'new',
    });
    if (candidate.success) found.push(candidate.data);
  }
  return found;
}

/** Куда уходит сырой ответ, который не прочитался: лог сервера. */
export type UnreadableLog = (source: string, excerpt: string) => void;

/** Начало и конец ответа: вступление и обрыв видны, середина не нужна. */
export function answerExcerpt(reply: string, edge = 400): string {
  if (reply.length <= edge * 2) return reply;
  return `${reply.slice(0, edge)}
…[${reply.length - edge * 2} chars]…
${reply.slice(-edge)}`;
}

async function discoverOne(
  spec: DiscoverySpec,
  cache: DiscoveryCache,
  ask: GroupAsk,
  prompt: string,
  now: () => string,
  onUnreadable?: UnreadableLog,
): Promise<DiscoverySourceResult> {
  const items = readInventory(spec.layout);
  const hash = inventoryHash(items);
  const cached = cache.sources[spec.source];
  // Находки старого вида (без второго языка) спрашиваются заново один раз.
  const current = cached?.groups.length === 0 || (cached?.textVersion ?? 1) >= TEXT_VERSION;
  if (cached && cached.inventoryHash === hash && !cached.error && current) {
    return { source: spec.source, state: 'cached', found: cached.groups.length };
  }
  if (items.length < MIN_ITEMS) {
    cache.sources[spec.source] = { inventoryHash: hash, groups: [], at: now() };
    return { source: spec.source, state: 'done', found: 0 };
  }
  try {
    const groups: DiscoveredGroup[] = [];
    const seenKeys = new Set<string>();
    const chunks = chunkInventory(items);
    for (const [index, chunk] of chunks.entries()) {
      const part = chunks.length > 1 ? ` (part ${index + 1} of ${chunks.length})` : '';
      const reply = await ask(
        singleTurn(prompt, `Source: ${spec.source}${part}\n\nInventory:\n${inventoryText(chunk)}`),
        'cheap',
      );
      const found = parseProposal(reply, spec, chunk, hash, seenKeys);
      if (!found) {
        // Сырой ответ — только в лог сервера: причину «не прочитано» иначе не
        // установить, а человеку в карточке нужен вывод, а не чужой текст.
        onUnreadable?.(spec.source, answerExcerpt(reply));
        throw new Error('unreadable');
      }
      groups.push(...found);
    }
    cache.sources[spec.source] = {
      inventoryHash: hash,
      groups,
      at: now(),
      textVersion: TEXT_VERSION,
    };
    return { source: spec.source, state: 'done', found: groups.length };
  } catch (error) {
    // Прежние находки не стираются: упавший вызов — не повод терять то, что уже было.
    const reason = error instanceof Error ? error.message : String(error);
    cache.sources[spec.source] = {
      inventoryHash: hash,
      groups: cached?.groups ?? [],
      at: now(),
      error: reason,
    };
    return {
      source: spec.source,
      state: 'failed',
      found: cached?.groups.length ?? 0,
      error: reason,
    };
  }
}

/**
 * Запустить обнаружение (если уже идёт — вернуть идущее). Ход пишет кэш
 * после каждого источника: оборванный прогон не теряет готовое.
 */
export function startDiscovery(
  appData: string,
  specs: readonly DiscoverySpec[],
  ask: GroupAsk,
  prompt: string,
  now: () => string = () => new Date().toISOString(),
  onUnreadable?: UnreadableLog,
): Promise<void> {
  const current = runs.get(appData);
  if (current?.running && current.done) return current.done;

  // Кэш — до регистрации прогона: сбой его чтения или переезда не оставляет
  // в журнале прогон, который «идёт» без исполнителя (F-188).
  const cache = settledCache(appData, specs);
  const state: RunState = {
    running: true,
    sources: specs.map((spec) => ({ source: spec.source, state: 'running', found: 0 })),
  };
  runs.set(appData, state);
  const queue = [...specs];
  const worker = async (): Promise<void> => {
    for (let spec = queue.shift(); spec; spec = queue.shift()) {
      const result = await discoverOne(spec, cache, ask, prompt, now, onUnreadable);
      state.sources = state.sources.map((item) => (item.source === spec.source ? result : item));
      writePanelJson(appData, DISCOVERY_FILE, cache);
    }
  };

  state.done = Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(
    () => {
      // Источник, которого больше нет (проект удалён), уходит из кэша.
      const live = new Set(specs.map((spec) => spec.source));
      for (const source of Object.keys(cache.sources)) {
        if (!live.has(source)) delete cache.sources[source];
      }
      cache.lastRunAt = now();
      writePanelJson(appData, DISCOVERY_FILE, cache);
      state.running = false;
    },
    (error: unknown) => {
      // Запись кэша упала — исполнители остановились, и необработанный источник
      // иначе навсегда оставался «идёт» (F-188). Причину видно в журнале.
      const reason = error instanceof Error ? error.message : String(error);
      state.sources = state.sources.map((item) =>
        item.state === 'running' ? { ...item, state: 'failed', error: reason } : item,
      );
      state.running = false;
    },
  );
  return state.done;
}

/** Вид для страницы: находки из кэша и ход последнего прогона. */
export function discoveryView(appData: string, specs: readonly DiscoverySpec[]): DiscoveryView {
  const cache = settledCache(appData, specs);
  const state = runs.get(appData);
  const live = new Set(specs.map((spec) => spec.source));
  const groups = Object.entries(cache.sources)
    .filter(([source]) => live.has(source))
    .flatMap(([, entry]) => entry.groups);
  // Источник, которого больше нет (снесённая копия, домашний каталог из старого
  // списка), не показывается и в журнале — прежде фильтровались только находки.
  const sources = (
    state?.sources ??
    Object.entries(cache.sources).map(([source, entry]) => ({
      source,
      state: entry.error ? ('failed' as const) : ('cached' as const),
      found: entry.groups.length,
      ...(entry.error ? { error: entry.error } : {}),
    }))
  )
    .filter((item) => live.has(item.source))
    .map((item) => (item.error ? { ...item, errorCode: discoveryErrorCode(item.error) } : item));
  return {
    groups,
    sources,
    ...(cache.lastRunAt ? { lastRunAt: cache.lastRunAt } : {}),
    running: state?.running ?? false,
  };
}

/** Код сбоя по его тексту: старые записи кэша хранят только текст. */
export function discoveryErrorCode(error: string): DiscoveryErrorCode {
  if (error === 'unreadable') return 'unreadable';
  if (error === CLI_TIMEOUT_ERROR) return 'timeout';
  return 'failed';
}

/** Сбросить память ходов — только для тестов. */
export function resetDiscoveryRuns(): void {
  runs.clear();
}
