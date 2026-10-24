import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  DEFERRED_ASK_STATES,
  type DeferredAskView,
  type DeferredScope,
} from '@agentdeck/contracts/deferred-asks';
import { writeJsonFile } from '../../../lib/safe-io/safe-io.ts';
import { maskSecretsInText } from '../../../lib/secret-mask/secret-mask.ts';
import { callHash } from './hash.ts';
import type {
  DeferredAskFile,
  DeferredAskInput,
  DeferredAskOutcome,
  DeferredAskRecord,
  DeferredAsksDeps,
  DeferredDecisionInput,
  DeferredDecisionOutcome,
  DeferredListener,
} from './deferred-asks.types.ts';

/**
 * Отложенные вопросы D-n — запись и жизнь (`deferred-asks.ts` контрактов).
 *
 * В отличие от `pending-asks.ts`, начало и конец хода записей НЕ снимают:
 * решение человека живёт дольше хода, часто — дольше сессии. Снимают их только
 * решение (`denied`; `consumed`, когда разрешение использовано), отзыв при
 * отмене плана (`withdrawn`) и срок (`expired`). Законченные записи видны
 * сутки, потом убираются; потолок — `LIMIT` записей.
 *
 * Файл пишется атомарно (`writeJsonFile`): перезапуск панели между вопросом и
 * ответом, и между ответом и продолжением, — обычное дело (git pull, сторож),
 * и полузаписанный файл потерял бы все ждущие решения разом.
 */

export const DEFERRED_ASKS_FILE = 'deferred-asks.json';
/** Сколько записей держать: ждущие не вытесняются никогда, законченные — старые первыми. */
const LIMIT = 200;
const DAY_MS = 86_400_000;
export const DEFERRED_TTL_MS = 7 * DAY_MS;
export const GRANT_MS = 2 * 3_600_000;
/** Сколько видна законченная запись. */
const KEEP_CLOSED_MS = DAY_MS;
/** Сколько решений карточек помнить для близнецов. */
const CARD_MARKS = 100;
const SUMMARY_MAX = 400;
/** Сколько байт вписываемого текста видит человек (`Write`, `Edit`). */
const DETAIL_MAX = 600;

export function sameScope(left: DeferredScope, right: DeferredScope): boolean {
  if (left.kind === 'group' && right.kind === 'group') {
    return left.parentChatId === right.parentChatId && left.groupIndex === right.groupIndex;
  }
  if (left.kind === 'chat' && right.kind === 'chat') {
    return left.chatKeys.some((key) => right.chatKeys.includes(key));
  }
  return false;
}

/**
 * Длинная строка с ОБОИМИ концами: опасное ставят в хвост длинной команды
 * (`…много безобидного…; curl … | sh`), и обрезка с начала скрывала его от
 * человека — он разрешал не то, что исполнится (D-S03, холодное ревью 23.10).
 * Отпечаток разрешения всегда считается по входу целиком, здесь — только показ.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.6);
  return `${text.slice(0, head)}…${text.slice(-(max - 1 - head))}`;
}

/** Что именно будет сделано — одной строкой, секреты под маской. */
export function summaryOf(toolName: string, input: unknown): string {
  const body = (input ?? {}) as Record<string, unknown>;
  const pick = ['command', 'file_path', 'path', 'notebook_path', 'url', 'query', 'sql']
    .map((key) => body[key])
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const raw = pick ?? (typeof input === 'string' ? input : JSON.stringify(input ?? {}));
  const flat = maskSecretsInText(raw).replace(/\s+/g, ' ').trim();
  const text = clip(flat, SUMMARY_MAX);
  return pick || toolName === 'Bash' ? text : `${toolName} ${text}`;
}

/**
 * Что именно впишется в файл — для инструментов, у которых в сводке только путь:
 * `Write` показывал имя файла, а `content` с `curl … | sh` человек не видел
 * вовсе (D-S03). Текст урезан с обоих концов и под маской секретов; решение
 * по-прежнему привязано к отпечатку входа целиком.
 */
export function detailOf(toolName: string, input: unknown): string | undefined {
  const body = (input ?? null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return undefined;
  const str = (key: string): string | undefined => {
    const value = body[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const show = (text: string): string => maskSecretsInText(clip(text, DETAIL_MAX));
  const content = str('content') ?? str('new_source') ?? str('new_str');
  if (content !== undefined) return show(content);
  const before = str('old_string') ?? str('old_str');
  const after = str('new_string') ?? str('new_str');
  if (before !== undefined || after !== undefined) {
    const half = Math.floor(DETAIL_MAX / 2);
    return `- ${maskSecretsInText(clip(before ?? '', half))}\n+ ${maskSecretsInText(clip(after ?? '', half))}`;
  }
  // Правок несколько (`MultiEdit`): показываем первую и число остальных. Счёт
  // — знаком, а не словами: язык панели выбирает человек, а текст показа кода
  // не несёт (`server-ru-literals`).
  const edits = Array.isArray(body.edits) ? (body.edits as unknown[]) : undefined;
  if (edits && edits.length > 0) {
    const first = detailOf(toolName, edits[0]);
    const rest = edits.length - 1;
    return first ? `${first}${rest > 0 ? `\n… (+${rest})` : ''}` : undefined;
  }
  return undefined;
}

export class DeferredAsks {
  private readonly deps: DeferredAsksDeps;
  private state: DeferredAskFile;
  private readonly created = new Set<DeferredListener>();
  private readonly decided = new Set<DeferredListener>();
  private readonly lapsed = new Set<DeferredListener>();
  private readonly changed = new Set<() => void>();
  /** Уборка срока зовёт слушателей, а те читают список — без этого рекурсия. */
  private sweeping = false;
  /**
   * Решения карточек (близнецы, RF-DL-02) — в памяти: близнецы живут в одном
   * ходе одного процесса, перезапуск панели снимает и сами карточки.
   */
  private cards: Array<{
    scope: DeferredScope;
    hash: string;
    behavior: 'allow' | 'deny';
    at: number;
  }> = [];

  constructor(deps: DeferredAsksDeps = {}) {
    this.deps = deps;
    this.state = deps.file ? readFile(deps.file, deps.log) : { version: 2, next: 1, records: [] };
  }

  /** Новая запись — Telegram и вкладки (через сборку) узнают о ней отсюда. */
  onCreated(listener: DeferredListener): () => void {
    this.created.add(listener);
    return () => this.created.delete(listener);
  }

  /** Решение человека — разрешение или отказ. */
  onDecided(listener: DeferredListener): () => void {
    this.decided.add(listener);
    return () => this.decided.delete(listener);
  }

  /** Срок записи вышел без ответа человека — разговору тоже нужно слово. */
  onExpired(listener: DeferredListener): () => void {
    this.lapsed.add(listener);
    return () => this.lapsed.delete(listener);
  }

  /** Список изменился (любая запись) — вкладки и телефон перечитывают его. */
  onChanged(listener: () => void): () => void {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  }

  /**
   * Вызов решает только человек. Тот же вызов (по отпечатку) той же группы или
   * чата, пока запись ждёт, — `queued`; после отказа человека — `refused`.
   * Повтор новой записи не заводит.
   */
  ask(input: DeferredAskInput): DeferredAskOutcome {
    this.sweep();
    const hash = callHash(input.toolName, input.input);
    const known = this.retryOf(input.scope, input.toolName, input.input);
    if (known) {
      return { kind: known.state === 'denied' ? 'refused' : 'queued', record: known };
    }
    const at = this.now();
    // Истёкшая запись того же вызова (срок ожидания или разрешения) открывается
    // ЗАНОВО под своим номером: иначе у одного вызова оказывались две записи —
    // «истекло, можно разрешить» и свежая D-n, и разрешение каждой давало своё
    // право (D-L07, живой прогон R8.4).
    const lapsed = this.state.records.find(
      (record) =>
        record.hash === hash && record.state === 'expired' && sameScope(record.scope, input.scope),
    );
    if (lapsed) {
      lapsed.state = 'waiting';
      lapsed.retries = (lapsed.retries ?? 0) + 1;
      lapsed.askedAt = new Date(at).toISOString();
      lapsed.expiresAt = new Date(at + this.ttl()).toISOString();
      if (input.toolUseId) lapsed.toolUseId = input.toolUseId;
      delete lapsed.closedAt;
      delete lapsed.decidedAt;
      delete lapsed.decidedVia;
      delete lapsed.grantUntil;
      delete lapsed.resumedAt;
      delete lapsed.toldAt;
      delete lapsed.consumedAt;
      delete lapsed.message;
      this.save();
      this.fire(this.created, lapsed);
      return { kind: 'created', record: lapsed };
    }
    const record: DeferredAskRecord = {
      id: `D-${this.state.next}`,
      state: 'waiting',
      kind: input.kind ?? 'permission',
      scope: input.scope,
      runKeys: [...new Set(input.runKeys.filter(Boolean))],
      toolName: input.toolName,
      input: input.input,
      hash,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      reason: input.reason,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      ...(input.reasonParams ? { reasonParams: input.reasonParams } : {}),
      askedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + this.ttl()).toISOString(),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      source: input.source ?? {},
    };
    this.state.next += 1;
    this.state.records.push(record);
    this.trim();
    this.save();
    this.fire(this.created, record);
    return { kind: 'created', record };
  }

  /**
   * Тот же вызов (по отпечатку) этой группы или чата, пока запись ждёт решения
   * или уже запрещена, — её запись и отметка о повторе. Мост прав спрашивает ДО
   * карточки: повтор при человеке у экрана получал свежую карточку, вызов
   * исполнялся с неё, а D-n оставалась ждать — разрешённая позже, она исполняла
   * его второй раз (D-L01, живой прогон R4).
   */
  retryOf(scope: DeferredScope, toolName: string, input: unknown): DeferredAskRecord | undefined {
    this.sweep();
    const hash = callHash(toolName, input);
    const known = this.state.records.find(
      (record) =>
        record.hash === hash &&
        (record.state === 'waiting' || record.state === 'denied') &&
        sameScope(record.scope, scope),
    );
    if (!known) return undefined;
    known.retries = (known.retries ?? 0) + 1;
    this.save();
    return known;
  }

  /**
   * Разрешение на ровно этот вызов в этой группе/чате: есть и не истекло —
   * погашается (один раз) и возвращается запись. Иначе `undefined`.
   */
  consume(scope: DeferredScope, toolName: string, input: unknown): DeferredAskRecord | undefined {
    this.sweep();
    const hash = callHash(toolName, input);
    const at = this.now();
    const record = this.state.records.find(
      (item) =>
        item.state === 'allowed' &&
        item.hash === hash &&
        sameScope(item.scope, scope) &&
        item.grantUntil !== undefined &&
        Date.parse(item.grantUntil) > at,
    );
    if (!record) return undefined;
    record.state = 'consumed';
    record.consumedAt = new Date(at).toISOString();
    record.closedAt = record.consumedAt;
    this.save();
    return record;
  }

  /**
   * Ответ человека. Повторный ответ на уже решённое — состояние как есть, без
   * второго решения. Истёкшую запись (срок ожидания или разрешения) человек
   * вправе разрешить заново — это новое разрешение (решение 7).
   */
  decide(id: string, decision: DeferredDecisionInput): DeferredDecisionOutcome | undefined {
    // Срок этой записи вышел за миг до ответа: уборка её отметит истёкшей, но
    // слова «истекло, заканчивайте без него» не будет — ответ человека уже здесь,
    // и группа получила бы сначала «без него», потом «разрешено» (RF-DL-15).
    this.sweep(id);
    const record = this.state.records.find((item) => item.id === id);
    if (!record) return undefined;
    // Истёкшая — решается в любую сторону: «нет» тоже слово человека, и повтор
    // вызова после него получит отказ человека, а не новую запись.
    if (record.state !== 'waiting' && record.state !== 'expired') return { record, changed: false };
    const at = this.now();
    record.decidedAt = new Date(at).toISOString();
    record.decidedVia = decision.via;
    // Исход сменился — слово о нём ещё не сказано (истечение, если было, отменено).
    delete record.toldAt;
    const message = decision.message?.trim();
    if (message) record.message = message.slice(0, 2000);
    else delete record.message;
    if (decision.behavior === 'allow') {
      record.state = 'allowed';
      record.grantUntil = new Date(at + (this.deps.grantMs ?? GRANT_MS)).toISOString();
      delete record.resumedAt;
      delete record.closedAt;
    } else {
      record.state = 'denied';
      record.closedAt = record.decidedAt;
    }
    this.save();
    this.fire(this.decided, record);
    return { record, changed: true };
  }

  /** Продолжение заведено — повторный обход при старте его не повторит. */
  markResumed(id: string): void {
    this.markTold([id]);
  }

  /**
   * Слово об исходе этих записей дошло до разговора. У разрешённой это и есть
   * «продолжение заведено» (`resumedAt`). Записи, сменившие исход с тех пор,
   * как слово сложено, не помечаются: слово было о прежнем.
   */
  markTold(ids: readonly string[], states?: ReadonlyMap<string, DeferredAskRecord['state']>): void {
    const at = new Date(this.now()).toISOString();
    let changed = false;
    for (const record of this.state.records) {
      if (!ids.includes(record.id)) continue;
      if (states && states.get(record.id) !== record.state) continue;
      record.toldAt = at;
      if (record.state === 'allowed') record.resumedAt = at;
      changed = true;
    }
    if (changed) this.save();
  }

  /**
   * Карточка вызова решена человеком сразу (без D-n). Близнец этого вызова —
   * тот же вызов той же группы/чата, ушедший в D-n, — закрывается тем же
   * решением: вызов один, и решение одно. Иначе два одинаковых вызова в одном
   * ответе модели исполнялись дважды — с карточки и с поздно разрешённой D-n
   * (RF-DL-02). Слово разговору не нужно: ответ ушёл ему с карточкой.
   */
  cardDecided(
    scope: DeferredScope,
    toolName: string,
    input: unknown,
    behavior: 'allow' | 'deny',
  ): DeferredAskRecord[] {
    this.sweep();
    const hash = callHash(toolName, input);
    const at = this.now();
    this.cards = this.cards.filter((card) => at - card.at < KEEP_CLOSED_MS).slice(-CARD_MARKS);
    this.cards.push({ scope, hash, behavior, at });
    const iso = new Date(at).toISOString();
    const closed: DeferredAskRecord[] = [];
    for (const record of this.state.records) {
      if (record.hash !== hash || record.state !== 'waiting') continue;
      if (!sameScope(record.scope, scope)) continue;
      record.state = behavior === 'allow' ? 'consumed' : 'denied';
      record.decidedAt = iso;
      record.decidedVia = 'web';
      record.closedAt = iso;
      record.toldAt = iso;
      if (behavior === 'allow') record.consumedAt = iso;
      closed.push(record);
    }
    if (closed.length > 0) this.save();
    return closed;
  }

  /**
   * Близнец этого вызова решён человеком с карточки ПОСЛЕ `since` (когда
   * показали карточку самого вызова) — значит, оба ждали одновременно: это
   * один вызов, повторённый моделью в одном ответе, и решение уже есть.
   * Повтор позже (`git push` после новых коммитов) — новый вызов: его решение
   * было раньше показа, и сюда он не попадает.
   */
  twinDecided(
    scope: DeferredScope,
    toolName: string,
    input: unknown,
    since: number,
  ): 'allow' | 'deny' | undefined {
    const hash = callHash(toolName, input);
    const twin = [...this.cards]
      .reverse()
      .find((card) => card.hash === hash && card.at >= since && sameScope(card.scope, scope));
    return twin?.behavior;
  }

  /** План отменён или чат удалён: ждущие и неиспользованные записи отзываются. */
  withdraw(match: (scope: DeferredScope) => boolean): DeferredAskRecord[] {
    const at = new Date(this.now()).toISOString();
    const gone: DeferredAskRecord[] = [];
    for (const record of this.state.records) {
      if (record.state !== 'waiting' && record.state !== 'allowed') continue;
      if (!match(record.scope)) continue;
      record.state = 'withdrawn';
      record.closedAt = at;
      gone.push(record);
    }
    if (gone.length > 0) this.save();
    return gone;
  }

  /** Ждущие записи группы/чата. */
  waiting(scope: DeferredScope): DeferredAskRecord[] {
    this.sweep();
    return this.state.records.filter(
      (record) => record.state === 'waiting' && sameScope(record.scope, scope),
    );
  }

  /** Разрешённые, чьё продолжение ещё не заведено, — обход при старте панели. */
  unresumed(): DeferredAskRecord[] {
    this.sweep();
    return this.state.records.filter((record) => record.state === 'allowed' && !record.resumedAt);
  }

  get(id: string): DeferredAskRecord | undefined {
    this.sweep();
    return this.state.records.find((record) => record.id === id);
  }

  /** Запись, поднятая с карточки этого вызова (кнопки карточки после «отложено»). */
  byToolUse(keys: readonly string[], toolUseId: string): DeferredAskRecord | undefined {
    return this.state.records.find(
      (record) =>
        record.toolUseId === toolUseId && record.runKeys.some((key) => keys.includes(key)),
    );
  }

  all(): DeferredAskRecord[] {
    this.sweep();
    return [...this.state.records];
  }

  /**
   * Срок ожидания и разрешения, уборка законченных старше суток. `quiet` —
   * запись, которую сейчас решает человек: истекает она молча (`decide`).
   */
  sweep(quiet?: string): void {
    if (this.sweeping) return;
    this.sweeping = true;
    const at = this.now();
    let changed = false;
    const lapsedNow: DeferredAskRecord[] = [];
    for (const record of this.state.records) {
      const lapsed =
        (record.state === 'waiting' && Date.parse(record.expiresAt) <= at) ||
        (record.state === 'allowed' &&
          record.grantUntil !== undefined &&
          Date.parse(record.grantUntil) <= at);
      if (lapsed) {
        record.state = 'expired';
        record.closedAt = new Date(at).toISOString();
        // Новый исход — слово о нём ещё не сказано (и переживёт перезапуск).
        delete record.toldAt;
        changed = true;
        if (record.id !== quiet) lapsedNow.push(record);
      }
    }
    const kept = this.state.records.filter(
      (record) => !record.closedAt || at - Date.parse(record.closedAt) < KEEP_CLOSED_MS,
    );
    if (kept.length !== this.state.records.length) {
      this.state.records = kept;
      changed = true;
    }
    if (changed) this.save();
    this.sweeping = false;
    // Срок вышел — это тоже исход записи: группа, которая кончила ход ожиданием,
    // иначе стояла бы до сторожа, а MR остался бы черновиком навсегда (D-L12).
    for (const record of lapsedNow) this.fire(this.lapsed, record);
  }

  private trim(): void {
    const over = this.state.records.length - LIMIT;
    if (over <= 0) return;
    const closed = this.state.records.filter((record) => record.closedAt);
    const drop = new Set(closed.slice(0, over));
    this.state.records = this.state.records.filter((record) => !drop.has(record));
  }

  private ttl(): number {
    const value = this.deps.ttlMs?.();
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFERRED_TTL_MS;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private save(): void {
    if (this.deps.file) {
      try {
        writeJsonFile(this.deps.file, this.state);
      } catch (error) {
        // Диск отказал — запись живёт в памяти до следующей удачной записи.
        this.deps.log?.('deferred asks: file not written', error);
      }
    }
    // Любая запись меняет список: заведено, решено, использовано, отозвано, истекло.
    for (const listener of this.changed) {
      try {
        listener();
      } catch (error) {
        this.deps.log?.('deferred asks: listener failed', error);
      }
    }
  }

  private fire(listeners: Set<DeferredListener>, record: DeferredAskRecord): void {
    for (const listener of listeners) {
      try {
        listener(record);
      } catch (error) {
        // Слушатель чужой (вкладки, Telegram): его сбой не отменяет записи.
        this.deps.log?.('deferred asks: listener failed', error);
      }
    }
  }
}

/** Запись для человека: без входа целиком, с маской. */
export function deferredView(record: DeferredAskRecord): DeferredAskView {
  const chatId = record.runKeys.find((key) => !key.startsWith('new-')) ?? record.runKeys[0];
  const detail = detailOf(record.toolName, record.input);
  return {
    id: record.id,
    state: record.state,
    kind: record.kind,
    scope: record.scope,
    toolName: record.toolName,
    summary: summaryOf(record.toolName, record.input),
    ...(detail !== undefined ? { detail } : {}),
    reason: record.reason,
    ...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
    ...(record.reasonParams ? { reasonParams: record.reasonParams } : {}),
    askedAt: record.askedAt,
    expiresAt: record.expiresAt,
    ...(record.retries ? { retries: record.retries } : {}),
    ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
    ...(record.decidedVia ? { decidedVia: record.decidedVia } : {}),
    ...(record.message ? { message: record.message } : {}),
    ...(record.state === 'allowed' && record.grantUntil ? { grantUntil: record.grantUntil } : {}),
    ...(record.resumedAt ? { resumedAt: record.resumedAt } : {}),
    ...(chatId ? { chatId } : {}),
    source: record.source,
  };
}

function readFile(file: string, log?: DeferredAsksDeps['log']): DeferredAskFile {
  // Файла нет (удалён, или обрыв между отводом битого и записью свежего) — счёт
  // номеров всё равно продолжается с отведённых `.bad-…`: иначе снова D-1, и
  // номер значил бы два разных вызова (RF-DL-12, живые прогоны T2B).
  const empty: DeferredAskFile = { version: 2, next: asideFloor(file), records: [] };
  if (!existsSync(file)) return empty;
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as {
      version?: number;
      next?: unknown;
      records?: unknown;
    } | null;
    const records = Array.isArray(parsed?.records) ? parsed.records.filter(isRecord) : [];
    if (parsed?.version !== 2) for (const record of records) assumeTold(record);
    // Счёт — не меньше самого большого номера: битый `next` не повторит номер.
    const top = records.reduce((max, record) => Math.max(max, Number(record.id.slice(2)) || 0), 0);
    const next = Math.max(
      typeof parsed?.next === 'number' && parsed.next > top ? parsed.next : top + 1,
      empty.next,
    );
    return { version: 2, next, records };
  } catch (error) {
    // Битый файл (обрыв записи, сбой диска) — пусто: хуже уронить сервер, чем
    // потерять список. Но потеря ВИДНА и не тихая (D-L06, живой прогон R7):
    // файл сохраняется рядом как `.bad-…` (иначе первая же запись его затирала),
    // о потере пишется в журнал, а счёт номеров берётся из самого битого текста —
    // иначе нумерация начиналась заново с D-1, и номер значил бы два разных
    // вызова (у Telegram он уже «отправлен», и новый вопрос не ушёл бы вовсе).
    const next = Math.max(numberFloor(raw), empty.next);
    const kept = keepAside(file);
    const fresh: DeferredAskFile = { ...empty, next };
    try {
      // Пустой файл на место битого сразу: иначе каталог остаётся с одним
      // `.bad-…`, а следующий сбой чтения не нашёл бы что убрать в сторону.
      writeJsonFile(file, fresh);
    } catch {
      // Диск отказал — список живёт в памяти до первой удачной записи.
    }
    log?.(
      `deferred asks: ${file} is not readable, the list starts empty, numbering continues ` +
        `from D-${next}${kept ? `, broken file kept as ${kept}` : ''}`,
      error,
    );
    return fresh;
  }
}

/**
 * С какого номера продолжать счёт после потери файла. Берётся максимум из двух
 * следов в битом тексте: самый большой `"id":"D-12"` и поле `"next"` из головы
 * файла. Голова переживает обрыв записи чаще хвоста, поэтому `next` важен: без
 * него обрыв на половине файла давал номер уже выданной записи (живой прогон
 * R7.2 — после потери двух записей следующая снова звалась D-2).
 */
function numberFloor(raw: string): number {
  let top = 0;
  for (const [, digits] of raw.matchAll(/"D-(\d{1,9})"/g)) top = Math.max(top, Number(digits) || 0);
  const declared = /"next"\s*:\s*(\d{1,9})/.exec(raw);
  return Math.max(top + 1, Number(declared?.[1] ?? 0) || 0);
}

/** Самый большой номер в отведённых рядом `.bad-…` копиях — +1; нет их — 1. */
function asideFloor(file: string): number {
  const dir = dirname(file);
  const prefix = `${basename(file)}.bad-`;
  let floor = 1;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      try {
        floor = Math.max(floor, numberFloor(readFileSync(join(dir, name), 'utf8')));
      } catch {
        // Нечитаемая копия — счёт по остальным.
      }
    }
  } catch {
    // Каталога ещё нет — копий тоже.
  }
  return floor;
}

/**
 * Файл версии 1 не знал `toldAt`: решённые и закрытые записи считаются
 * сказанными (иначе первый же обход разослал бы группам старые отказы заново),
 * разрешённая — сказанной, если продолжение было заведено.
 */
function assumeTold(record: DeferredAskRecord): void {
  if (record.toldAt || record.state === 'waiting') return;
  const at = record.state === 'allowed' ? record.resumedAt : (record.closedAt ?? record.decidedAt);
  if (at) record.toldAt = at;
}

/** Битый файл — рядом под своим именем; не вышло убрать — пусть лежит как есть. */
function keepAside(file: string): string | undefined {
  const target = `${file}.bad-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    renameSync(file, target);
    return target;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is DeferredAskRecord {
  const record = value as Partial<DeferredAskRecord> | null;
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.id === 'string' &&
    /^D-\d+$/.test(record.id) &&
    typeof record.hash === 'string' &&
    typeof record.toolName === 'string' &&
    typeof record.askedAt === 'string' &&
    typeof record.expiresAt === 'string' &&
    DEFERRED_ASK_STATES.includes(record.state as DeferredAskRecord['state']) &&
    typeof record.scope === 'object' &&
    record.scope !== null &&
    Array.isArray(record.runKeys)
  );
}
