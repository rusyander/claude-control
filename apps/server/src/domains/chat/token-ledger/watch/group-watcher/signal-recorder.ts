import { randomUUID } from 'node:crypto';
import {
  CHAT_SCOPE_INDEX,
  groupSignalsOf,
  type GroupSignal,
  type GroupWatch,
  type GroupWatchRecord,
} from '@agentdeck/contracts/group-watch';
import { groupKeyOf } from '../group-ledgers.ts';
import { GROUP_LEVEL, GROUP_SCOPED_RULES, SESSION_RULES } from '../rules.ts';
import {
  clearChatSignals,
  mergeSignals,
  signalsToNotify,
  type MergeScope,
  type MergedSignals,
} from '../signals.ts';
import type { RuleHit } from '../watch.types.ts';
import { CORRELATED, correlationKey, r23Key } from './correlate.ts';
import type {
  ChatSignalStore,
  GroupWatcherDeps,
  WatchSignalStore,
  WatchTarget,
} from './group-watcher.types.ts';
import { IDLE_DROP_MS, TERMINAL } from './timing.ts';

/** Закрытые сигналы одиночного чата держим сутки: строке чата нужны только горящие. */
const CHAT_CLOSED_KEEP_MS = 24 * 60 * 60_000;
/**
 * Беды звена, которые R23 плана сводит по группам (F-52): R23 считается на тике, а эти
 * поднимаются в ходе — их сообщение ждёт тика, и накрытые R23 наружу не уходят.
 */
const R23_COVERS: ReadonlySet<string> = CORRELATED;

/** Без хранилища — блок `watch` на живой записи группы (проверки сторожа). */
function recordSignalStore(deps: GroupWatcherDeps): WatchSignalStore {
  return {
    get: (parent, index) => deps.group(parent, index)?.watch,
    set: (parent, index, record) => {
      const found = deps.group(parent, index);
      if (!found) return;
      if (record) found.watch = record;
      else delete found.watch;
    },
    all: () => {
      const out: Record<string, Record<string, unknown>> = {};
      for (const [parent, plan] of Object.entries(deps.plans?.() ?? {})) {
        for (const item of plan.groups) {
          if (item.watch !== undefined) (out[parent] ??= {})[String(item.index)] = item.watch;
        }
      }
      return out;
    },
  };
}

/** Без хранилища одиночных чатов — память сторожа (проверки). */
function memoryChatStore(): ChatSignalStore {
  const blocks = new Map<string, GroupWatchRecord>();
  return {
    get: (chatId) => blocks.get(chatId),
    set: (chatId, record) => {
      if (record) blocks.set(chatId, record);
      else blocks.delete(chatId);
    },
    all: () => Object.fromEntries(blocks),
  };
}

/**
 * Переезд сигналов чата на ключ `key` слиянием, а не склейкой (F-107): правило, уже активное
 * под `key`, — то же условие; его переехавший близнец отбрасывается. Иначе активных строк
 * правила на чат стало бы две, слияние вело бы одну, а вторая висела бы до конца условия.
 */
function withoutMovedTwins(
  kept: readonly GroupSignal[],
  moved: readonly GroupSignal[],
  key: string,
): GroupSignal[] {
  const active = new Set(
    kept.filter((signal) => !signal.clearedAt && signal.chatId === key).map((s) => s.rule),
  );
  return [
    ...kept,
    ...moved
      .filter((signal) => signal.clearedAt || !active.has(signal.rule))
      .map((signal) => ({ ...signal, chatId: key })),
  ];
}

/**
 * Ключ памяти отправленного: R9 — один на аккаунт, R8, R21, R22 и R28 — на группу,
 * R23 — на план и команду (поднят на каждой группе, сообщение одно), прочие — на чат.
 * R8 сейчас «заметка» и наружу не уходит; ключ на группу — на случай, когда станет.
 */
export function notifyKey(signal: GroupSignal, target: WatchTarget): string {
  if (signal.rule === 'R9') return 'R9';
  // R21 — тоже на группу: гейты считают все её разговоры, сообщение одно на группу.
  if (['R8', 'R21', 'R22', 'R28'].includes(signal.rule))
    return `${signal.rule}:${target.parentChatId}:${target.groupIndex}`;
  if (signal.rule === 'R23') return `R23:${target.parentChatId}:${r23Key(signal) ?? ''}`;
  return `${signal.rule}:${signal.chatId}`;
}

/**
 * Сигналы групп на их записях и одиночных чатов в своём срезе: слияние попаданий,
 * отложенная запись на диск, память отправленного наружу, закрытие сирот. О сессиях
 * не знает — их цели ему передаёт сторож; срез выбирает по `target.scope`.
 */
export class SignalRecorder {
  private readonly deps: GroupWatcherDeps;
  private readonly store: WatchSignalStore;
  private readonly chats: ChatSignalStore;
  private readonly dirty = new Set<string>();
  private readonly dirtyChats = new Set<string>();
  private readonly sent = new Map<string, { at: number; severity: GroupSignal['severity'] }>();
  /** Сообщения групп о бедах, которые может свести R23: ждут тика плана (`releasePending`). */
  private readonly pending = new Map<string, { signal: GroupSignal; target: WatchTarget }>();
  /** Старт сторожа: до него сигналы записаны прошлой жизнью панели. */
  private readonly bornAt: number;

  constructor(deps: GroupWatcherDeps, bornAt: number) {
    this.deps = deps;
    this.store = deps.signals ?? recordSignalStore(deps);
    this.chats = deps.chatSignals ?? memoryChatStore();
    this.bornAt = bornAt;
  }

  /** Сигналы группы звена; битый блок с диска (ручная правка state.json) — мимо поштучно. */
  signalsOf(parentChatId: string, groupIndex: number): GroupSignal[] {
    return groupSignalsOf(this.store.get(parentChatId, groupIndex));
  }

  /** Сигналы одиночного чата — тем же разбором, что у групп. */
  chatSignalsOf(chatId: string): GroupSignal[] {
    return groupSignalsOf(this.chats.get(chatId));
  }

  private read(target: WatchTarget): GroupSignal[] {
    return target.scope === 'chat'
      ? this.chatSignalsOf(target.chatId)
      : this.signalsOf(target.parentChatId, target.groupIndex);
  }

  /** Записать блок цели в память и отметить к записи на диск. */
  private write(target: WatchTarget, signals: GroupSignal[] | undefined): void {
    const record = signals ? { signals } : undefined;
    if (target.scope === 'chat') {
      this.chats.set(target.chatId, record);
      this.dirtyChats.add(target.chatId);
      return;
    }
    this.store.set(target.parentChatId, target.groupIndex, record);
    this.dirty.add(target.parentChatId);
  }

  /**
   * Поднятые сигналы чата `old` переезжают на его настоящий ключ `key`. У одиночного
   * чата переезжает весь блок: сигналы лежат под ключом самого чата.
   */
  moveChat(target: WatchTarget, old: string, key: string): void {
    if (target.scope === 'chat') {
      const moved = this.chatSignalsOf(old);
      if (moved.length === 0) return;
      const signals = withoutMovedTwins(this.chatSignalsOf(key), moved, key);
      this.write({ ...target, chatId: old }, undefined);
      this.write({ ...target, chatId: key, parentChatId: key }, signals);
      return;
    }
    const signals = this.signalsOf(target.parentChatId, target.groupIndex);
    if (!signals.some((signal) => signal.chatId === old)) return;
    this.write(
      target,
      withoutMovedTwins(
        signals.filter((signal) => signal.chatId !== old),
        signals.filter((signal) => signal.chatId === old),
        key,
      ),
    );
  }

  /**
   * Слить попадания в сигналы цели цепочкой (каждое слияние — со своими правилами),
   * записать: состав сменился — на диск сразу, числа — на тике. Поднятые впервые —
   * наружу, по памяти отправленного; у одиночного чата — только тревога.
   */
  record(
    target: WatchTarget,
    settings: GroupWatch,
    now: number,
    parts: ReadonlyArray<{ hits: readonly RuleHit[]; merge: MergeScope }>,
  ): void {
    const scope = {
      chatId: target.chatId,
      groupIndex: target.groupIndex,
      ...(target.stage ? { stage: target.stage } : {}),
    };
    let total: MergedSignals = {
      // Битый блок с диска (ручная правка state.json) — мимо поштучно, тик не падает.
      signals: this.read(target),
      raised: [],
      structural: false,
      numbers: false,
    };
    for (const part of parts) {
      const merged = mergeSignals(
        total.signals,
        scope,
        part.hits,
        now,
        this.deps.makeId ?? randomUUID,
        part.merge,
      );
      total = {
        signals: merged.signals,
        raised: [...total.raised, ...merged.raised],
        structural: total.structural || merged.structural,
        numbers: total.numbers || merged.numbers,
      };
    }
    if (!total.structural && !total.numbers) return;
    this.write(target, total.signals);
    // Состав сменился — на диск сразу; не вышло — запись остаётся отложенной до тика.
    if (total.structural) this.flushTarget(target);
    if (!this.deps.notify) return;
    const outward: GroupSignal[] = [];
    for (const signal of total.raised) {
      if (target.scope === 'chat') {
        if (signal.severity === 'alert') outward.push(signal);
      } else if (R23_COVERS.has(signal.rule)) {
        // Та же беда может быть в соседней группе — R23 узнает об этом только на тике.
        if (!this.coveredByR23(target, signal))
          this.pending.set(notifyKey(signal, target), { signal, target });
      } else outward.push(signal);
    }
    this.send(outward, target, settings, now);
  }

  private send(
    signals: readonly GroupSignal[],
    target: WatchTarget,
    settings: GroupWatch,
    now: number,
  ): void {
    if (signals.length === 0 || !this.deps.notify) return;
    const due = signalsToNotify(
      signals,
      (signal) => notifyKey(signal, target),
      this.sent,
      settings.cooldownMinutes * 60_000,
      now,
    );
    for (const signal of due) this.deps.notify(signal, target);
  }

  /**
   * Тик плана прошёл (R23 посчитан): отложенные сообщения групп — наружу, кроме накрытых
   * R23 и уже погасших. `enabled=false` — сторож выключен, отложенное просто забыто.
   */
  releasePending(settings: GroupWatch, now: number, enabled = true): void {
    const held = [...this.pending.values()];
    this.pending.clear();
    if (!enabled) return;
    for (const { signal, target } of held) {
      const live = this.read(target).some((one) => one.id === signal.id && !one.clearedAt);
      if (!live || this.coveredByR23(target, signal)) continue;
      this.send([signal], target, settings, now);
    }
  }

  /**
   * Беда звена, которую уже назвал R23 плана с той же командой: сообщение о ней одно на
   * план (R23), повторы по группам — шум. Строка на карточке остаётся.
   */
  private coveredByR23(target: WatchTarget, signal: GroupSignal): boolean {
    if (!R23_COVERS.has(signal.rule)) return false;
    const key = correlationKey(signal);
    if (!key) return false;
    const groups = this.store.all()[target.parentChatId] ?? {};
    return Object.values(groups).some((block) =>
      groupSignalsOf(block).some(
        (held) => held.rule === 'R23' && !held.clearedAt && r23Key(held) === key,
      ),
    );
  }

  private flushTarget(target: WatchTarget): void {
    if (target.scope === 'chat') this.flushChat(target.chatId);
    else this.flush(target.parentChatId);
  }

  /** Записать разделение родителя; сбой записи — в журнал, разделение остаётся отложенным. */
  private flush(parentChatId: string): void {
    try {
      this.deps.save(parentChatId);
      this.dirty.delete(parentChatId);
    } catch (error) {
      this.deps.log?.('[group-watch] save failed', error);
    }
  }

  private flushChat(chatId: string): void {
    try {
      this.deps.saveChat?.(chatId);
      this.dirtyChats.delete(chatId);
    } catch (error) {
      this.deps.log?.('[group-watch] chat save failed', error);
    }
  }

  /** Отложенные числа сигналов — на диск. */
  flushDirty(): void {
    for (const parent of [...this.dirty]) this.flush(parent);
    for (const chatId of [...this.dirtyChats]) this.flushChat(chatId);
  }

  /**
   * Активные сигналы, за которыми нет сессии: панель перезапускалась, сторож
   * выключали. Сигнал сессии — сирота, когда за его чатом сессии нет; сигнал
   * группы (R8, R9) — когда нет ни одной сессии группы. Группа кончилась или
   * сторож выключен — закрыть сразу; иначе — когда сторож живёт дольше
   * `IDLE_DROP_MS`, а разговор так и не дал о себе знать. Правила группы
   * (`GROUP_LEVEL`) сессии не требуют — их обход идёт по каждой живой группе,
   * сиротами они становятся только с концом группы. `live` — цели сессий под наблюдением.
   */
  closeOrphans(
    now: number,
    enabled: boolean,
    live: readonly WatchTarget[],
    singleChats = true,
  ): void {
    const stored = this.store.all();
    const watched = new Set(live.map((target) => target.chatId));
    const watchedGroups = new Set(
      live.map((target) => groupKeyOf(target.parentChatId, target.groupIndex)),
    );
    const settled = !enabled || now - this.bornAt > IDLE_DROP_MS;
    const iso = new Date(now).toISOString();
    for (const [parentChatId, groups] of Object.entries(stored)) {
      for (const [key, block] of Object.entries(groups)) {
        const groupIndex = Number(key);
        const signals = groupSignalsOf(block);
        if (!signals.some((signal) => !signal.clearedAt)) continue;
        // Группы уже нет в записи разделения — она кончилась для сторожа.
        const status = this.deps.group(parentChatId, groupIndex)?.status;
        const over = status === undefined || TERMINAL.has(status);
        if (!(over || settled)) continue;
        const groupWatched = watchedGroups.has(groupKeyOf(parentChatId, groupIndex));
        const orphan = (signal: GroupSignal): boolean => {
          if (signal.clearedAt) return false;
          if (GROUP_LEVEL.has(signal.rule)) return over || !enabled;
          return GROUP_SCOPED_RULES.has(signal.rule) ? !groupWatched : !watched.has(signal.chatId);
        };
        if (!signals.some(orphan)) continue;
        this.write(
          { chatId: parentChatId, parentChatId, groupIndex },
          signals.map((signal) => (orphan(signal) ? { ...signal, clearedAt: iso } : signal)),
        );
      }
    }
    // Слежка за одиночными чатами выключена — следить не за кем, как при выключенном стороже.
    this.closeChatOrphans(now, enabled && singleChats ? settled : true, watched, iso);
  }

  /** Сироты одиночных чатов: сессии за чатом нет; закрытые старше суток — с диска долой. */
  private closeChatOrphans(
    now: number,
    settled: boolean,
    watched: ReadonlySet<string>,
    iso: string,
  ): void {
    for (const [chatId, block] of Object.entries(this.chats.all())) {
      const target: WatchTarget = {
        scope: 'chat',
        chatId,
        parentChatId: chatId,
        groupIndex: CHAT_SCOPE_INDEX,
      };
      const signals = groupSignalsOf(block);
      const active = signals.some((signal) => !signal.clearedAt);
      if (!active) {
        const newest = Math.max(
          0,
          ...signals.map((signal) => Date.parse(signal.clearedAt ?? signal.at) || 0),
        );
        if (now - newest > CHAT_CLOSED_KEEP_MS) this.write(target, undefined);
        continue;
      }
      if (!settled || watched.has(chatId)) continue;
      this.write(
        target,
        signals.map((signal) => (signal.clearedAt ? signal : { ...signal, clearedAt: iso })),
      );
    }
  }

  /** Сессия забыта: закрыть только её сигналы — R8/R9 о группе, их закрывает её оценка или сиротство. */
  clearChat(target: WatchTarget, now: number): void {
    const signals = this.read(target);
    if (signals.length === 0) return;
    const cleared = clearChatSignals(signals, target.chatId, now, SESSION_RULES);
    if (!cleared.changed) return;
    this.write(target, cleared.signals);
  }
}
