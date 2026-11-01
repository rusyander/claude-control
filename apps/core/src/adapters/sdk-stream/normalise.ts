import type {
  AdapterErrorCode,
  AdapterEvent,
  PermissionAsk,
  RawToolCall,
  TurnOrigin,
  TurnUsage,
  WindowObservation,
} from '../adapter.types.ts';
import { readToolOutcome, type OutcomeRule } from './outcome.ts';

/**
 * Разбор потока `stream-json` (формат SDK, на нём говорят и Claude Code, и Qwen Code) в
 * события ядра (03 §CLI adapter). Чистый: строка на входе, события на выходе, без часов и IO —
 * поэтому одни и те же записанные потоки проверяют его в тестах и в живых прогонах.
 *
 * Привязка хода к нашей отправке — правило переходника (R:S2-04):
 * - `echo: true` — CLI возвращает наш uuid (`--replay-user-messages`, `command_lifecycle
 *   started`), ход наш только по этому эху;
 * - `echo: false` — эха нет: ядро шлёт по одной (насос ждёт простоя), и следующий начавшийся
 *   ход берёт первую ждущую отправку. Ход, начатый CLI ровно в миг нашей отправки, так
 *   приписался бы нам — названный остаток правила.
 *
 * Ход без нашей отправки — `turn.cli-initiated` (уведомление `num_turns 0`, пробуждение
 * фоновой задачи `num_turns ≥ 1`, поздний хвост уже закрытого хода): его инструменты идут с
 * `cliInitiated`, концом нашего хода он не становится никогда.
 */

/** Запрос CLI по управляющему каналу протокола (`control_request`): ответ ждёт в stdin. */
export interface ControlRequest {
  requestId: string;
  subtype: string;
  request: Record<string, unknown>;
}

/** Отказ хука человека, прочитанный переходником из строки CLI (G-e). */
export interface HookRefusalRead {
  toolUseId: string | null;
  event: string;
  /** Ключ описи (`<событие>.<группа>.<хук>`), когда команда названа и найдена; иначе `null`. */
  hook: string | null;
  reason: string;
  /** Отказ Stop — продолжение, начатое CLI, а не наш ход. */
  cliInitiated?: true;
}

export interface SdkRule {
  echo: boolean;
  /**
   * Отказы хуков человека в строке CLI (`user`/`system`). Нет — CLI отказ хука не отличает от
   * ошибки инструмента (Qwen, проба Q7): `hook.refused` не издаётся.
   */
  hookRefusals?(line: Record<string, unknown>): HookRefusalRead[];
  mapPermission(raw: RawToolCall): PermissionAsk;
  /** Код ядра по тексту ошибки CLI (поток или stderr); нет — общий код места. */
  classifyError?(text: string): AdapterErrorCode | null;
  /**
   * Строка окна подписки этого CLI (`windowEvent: true`). Нет — у CLI событие окна не
   * задокументировано: окно `unknown`, отказ читается в потоке (G13).
   */
  readWindow?(line: Record<string, unknown>): WindowObservation | undefined;
  /** Исход вызова из блока `tool_result` (этап 8, F18); нет — `tool.result` без `outcome`. */
  outcome?: OutcomeRule;
}

interface Pending {
  cmdId: string;
  uuid: string;
}

interface CoreTurn {
  cmdId: string;
  uuid: string;
  origin: TurnOrigin;
}

type Turn =
  /** `folded` — наши отправки, чьё эхо пришло посреди хода: CLI влил их в этот ход (F-38). */
  | (CoreTurn & { kind: 'core'; folded: CoreTurn[] })
  | { kind: 'cli' }
  /** Поздний хвост: строки уже закрытого хода, `result` за ними не придёт. */
  | { kind: 'tail' };

type Json = Record<string, unknown>;

interface UsageMeta {
  model?: string;
  subagent?: boolean;
}

/** Строка подагента: CLI метит её вызовом-родителем (`parent_tool_use_id`). */
const subagentLine = (o: Json): boolean =>
  typeof o.parent_tool_use_id === 'string' && o.parent_tool_use_id !== '';

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

export class SdkNormaliser {
  private readonly rule: SdkRule;
  private pending: Pending[] = [];
  private readonly ended = new Set<string>();
  private turn: Turn | null = null;
  private conversation: string | null = null;
  private readonly usageById = new Map<string, TurnUsage>();
  /** Последний изданный учёт сообщения: вырос после издания — издаётся снова (F-98). */
  private readonly usageSent = new Map<string, string>();
  /** Сообщения текущего хода: учёт без `message_start` (без частичных событий) — тоже в ход. */
  private turnMessages = new Set<string>();
  /** Сообщения, чей учёт издан в текущем ходе: по ним сверяется итог `result` (остаток). */
  private turnSent = new Set<string>();
  /** Окно контекста модели, как его назвал CLI (`result.modelUsage.<model>.contextWindow`). */
  private readonly windows = new Map<string, number>();
  private remainders = 0;
  private message: string | null = null;
  private controls: ControlRequest[] = [];

  constructor(rule: SdkRule) {
    this.rule = rule;
  }

  /** Наша отправка ушла в stdin: ждём её эха (или, без эха, — следующего хода). */
  expect(cmdId: string, uuid: string): void {
    this.pending.push({ cmdId, uuid });
  }

  /**
   * Отправка не дошла до CLI (хост отказал в записи): её ожидание снимается, иначе без эха
   * `waiting` не опустеет и насос не отправит больше ничего (F-38).
   */
  forget(cmdId: string): void {
    this.pending = this.pending.filter((p) => p.cmdId !== cmdId);
  }

  /** Идёт ход, за которым нельзя слать (свой или начатый CLI); хвост не держит. */
  get busy(): boolean {
    return this.turn !== null && this.turn.kind !== 'tail';
  }

  /** Идёт ход, начатый CLI: за ним ядро не шлёт никогда (03). */
  get cliBusy(): boolean {
    return this.turn?.kind === 'cli';
  }

  /** Отправки, ход которых ещё не начался. */
  get waiting(): number {
    return this.pending.length;
  }

  get conversationId(): string | null {
    return this.conversation;
  }

  usage(): TurnUsage[] {
    return [...this.usageById.values()];
  }

  /** Управляющие запросы CLI с прошлого вызова; отвечает на них насос сессии. */
  takeControl(): ControlRequest[] {
    const out = this.controls;
    this.controls = [];
    return out;
  }

  push(line: string): AdapterEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [{ type: 'error', code: 'protocol', detail: `not JSON: ${line.slice(0, 120)}` }];
    }
    if (!isObject(parsed)) return [{ type: 'error', code: 'protocol', detail: 'not an object' }];
    const o = parsed;
    switch (o.type) {
      case 'command_lifecycle':
        return this.lifecycle(o);
      case 'system':
        return this.system(o);
      case 'user':
        return this.user(o);
      case 'stream_event':
        return this.streamEvent(o);
      case 'assistant':
        return this.assistant(o);
      case 'result':
        return this.result(o);
      case 'control_request': {
        const request = isObject(o.request) ? o.request : {};
        const requestId = str(o.request_id);
        if (!requestId)
          return [{ type: 'error', code: 'protocol', detail: 'control request without id' }];
        this.controls.push({ requestId, subtype: str(request.subtype) ?? '', request });
        return [];
      }
      default: {
        const window = this.rule.readWindow?.(o);
        return window ? [{ type: 'window', ...window }] : [];
      }
    }
  }

  private take(uuid: string | undefined): Pending | undefined {
    if (!uuid) return undefined;
    const at = this.pending.findIndex((p) => p.uuid === uuid);
    return at < 0 ? undefined : this.pending.splice(at, 1)[0];
  }

  private openCore(p: Pending, origin: TurnOrigin): AdapterEvent[] {
    const out: AdapterEvent[] = [];
    // Эхо второй отправки посреди нашего хода: CLI влил её в идущий ход. Первая команда не
    // теряется — обе кончаются на `result` этого хода (F-38).
    if (this.turn?.kind === 'core') {
      this.turn.folded.push({ cmdId: p.cmdId, uuid: p.uuid, origin });
      return [{ type: 'turn.started', attribution: p.cmdId, origin }];
    }
    // Незакрытый ход CLI, который сменила наша команда, — хвост без `result`.
    if (this.turn?.kind === 'cli') {
      out.push({ type: 'turn.cli-initiated', cause: 'late-tail', numTurns: 0 });
    }
    this.turn = { kind: 'core', cmdId: p.cmdId, uuid: p.uuid, origin, folded: [] };
    out.push({ type: 'turn.started', attribution: p.cmdId, origin });
    return out;
  }

  /** Строка содержания хода пришла, а хода нет: решает правило привязки. */
  private ensureTurn(o: Json): AdapterEvent[] {
    if (this.turn) return [];
    if (this.rule.echo) {
      const ids = Array.isArray(o.user_message_uuids) ? o.user_message_uuids : [];
      const uuid = str(o.user_message_uuid) ?? str(ids[0]);
      if (uuid && this.ended.has(uuid)) {
        this.turn = { kind: 'tail' };
        return [{ type: 'turn.cli-initiated', cause: 'late-tail', numTurns: 0 }];
      }
      this.turn = { kind: 'cli' };
      return [];
    }
    const next = this.pending.shift();
    if (next) return this.openCore(next, 'sequence');
    this.turn = { kind: 'cli' };
    return [];
  }

  private get cliInitiated(): boolean {
    return this.turn?.kind !== 'core';
  }

  private lifecycle(o: Json): AdapterEvent[] {
    if (!this.rule.echo || o.state !== 'started') return [];
    const p = this.take(str(o.command_uuid));
    return p ? this.openCore(p, 'echo') : [];
  }

  /** Отказ хука человека — событием; блок UserPromptSubmit закрывает нашу отправку без эха. */
  private refusals(o: Json): AdapterEvent[] {
    const read = this.rule.hookRefusals?.(o) ?? [];
    const out: AdapterEvent[] = [];
    for (const r of read) {
      // Отправку, которую хук не пустил, CLI не повторяет эхом (Q2): её ход открывается здесь и
      // кончается на `result` с `num_turns: 0` — иначе ждущая держала бы насос (F-38).
      if (r.event === 'UserPromptSubmit' && this.turn === null) {
        const next = this.pending.shift();
        if (next) out.push(...this.openCore(next, 'sequence'));
      }
      out.push({
        type: 'hook.refused',
        toolUseId: r.toolUseId,
        event: r.event,
        hook: r.hook,
        reason: r.reason,
        cliInitiated: r.cliInitiated === true || this.cliInitiated,
      });
    }
    return out;
  }

  private system(o: Json): AdapterEvent[] {
    if (o.subtype === 'informational') return this.refusals(o);
    if (o.subtype !== 'init') return [];
    const out = this.ensureTurn(o);
    const id = str(o.session_id);
    if (id && id !== this.conversation) {
      this.conversation = id;
      const servers = Array.isArray(o.mcp_servers) ? o.mcp_servers.filter(isObject) : [];
      out.push({
        type: 'init',
        conversationId: id,
        model: str(o.model) ?? '',
        tools: Array.isArray(o.tools)
          ? o.tools.filter((t): t is string => typeof t === 'string')
          : [],
        mcp: servers.map((s) => ({ name: str(s.name) ?? '', status: str(s.status) ?? '' })),
      });
    }
    return out;
  }

  private user(o: Json): AdapterEvent[] {
    if (o.isReplay === true) {
      if (!this.rule.echo) return [];
      // Эхо приходит и после `command_lifecycle started` — тогда ход уже открыт им.
      const open = this.turn?.kind === 'core' ? [this.turn, ...this.turn.folded] : [];
      if (open.some((t) => t.uuid === o.uuid)) return [];
      const p = this.take(str(o.uuid));
      return p ? this.openCore(p, 'echo') : [];
    }
    const content = isObject(o.message) ? o.message.content : undefined;
    if (!Array.isArray(content)) return o.isSynthetic === true ? this.refusals(o) : [];
    const results = content.filter((b) => isObject(b) && b.type === 'tool_result') as Json[];
    if (results.length === 0) return o.isSynthetic === true ? this.refusals(o) : [];
    const out = this.ensureTurn(o);
    for (const block of results) {
      out.push({
        type: 'tool.result',
        toolUseId: str(block.tool_use_id) ?? '',
        isError: block.is_error === true,
        cliInitiated: this.cliInitiated,
        ...(this.rule.outcome ? { outcome: readToolOutcome(block, this.rule.outcome) } : {}),
      });
    }
    out.push(...this.refusals(o));
    return out;
  }

  /**
   * `meta.model` — модель сообщения (`message_start`, `assistant`); `meta.subagent` — строка
   * несёт `parent_tool_use_id`: ход подагента, а не нашей сессии (родитель — сессия ядра).
   */
  private mergeUsage(id: string, raw: unknown, meta: UsageMeta = {}): void {
    if (!isObject(raw)) return;
    this.turnMessages.add(id);
    const was = this.usageById.get(id) ?? {
      messageId: id,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 0,
    };
    const split = isObject(raw.cache_creation) ? raw.cache_creation : {};
    const model = meta.model ?? was.model;
    const subagent = meta.subagent === true || was.subagent === true;
    // Поля приходят частями (начало сообщения — вход и часовая доля кэша, дельта — выход);
    // берём наибольшее.
    this.usageById.set(id, {
      messageId: id,
      input: Math.max(was.input, num(raw.input_tokens)),
      cacheRead: Math.max(was.cacheRead, num(raw.cache_read_input_tokens)),
      cacheWrite: Math.max(was.cacheWrite, num(raw.cache_creation_input_tokens)),
      cacheWrite1h: Math.max(was.cacheWrite1h ?? 0, num(split.ephemeral_1h_input_tokens)),
      output: Math.max(was.output, num(raw.output_tokens)),
      ...(model ? { model } : {}),
      ...(subagent ? { subagent } : {}),
    });
    this.attachWindow(id);
  }

  /**
   * Окна моделей из итога хода. Окно без имени модели не берётся; модель сообщения без имени
   * получает окно, только когда в разговоре модель была одна (как модель остатка).
   */
  private learnWindows(o: Json): void {
    if (!isObject(o.modelUsage)) return;
    for (const [model, u] of Object.entries(o.modelUsage)) {
      const w = isObject(u) ? u.contextWindow : undefined;
      if (typeof w === 'number' && Number.isInteger(w) && w > 0) this.windows.set(model, w);
    }
  }

  private attachWindow(id: string): void {
    const u = this.usageById.get(id);
    if (!u) return;
    const only = this.windows.size === 1 ? [...this.windows.values()][0] : undefined;
    const window = u.model ? this.windows.get(u.model) : only;
    if (window !== undefined && u.contextWindow !== window)
      this.usageById.set(id, { ...u, contextWindow: window });
  }

  /**
   * Учёт сообщения — событием с ПОЛНЫМИ текущими числами (замена по `messageId`, не прибавка):
   * поздний рост (дельта после `message_stop`) издаётся снова, неизменный — нет.
   */
  private flushUsage(id: string | null): AdapterEvent[] {
    if (!id) return [];
    const usage = this.usageById.get(id);
    if (!usage) return [];
    const key = JSON.stringify(usage);
    if (this.usageSent.get(id) === key) return [];
    this.usageSent.set(id, key);
    this.turnSent.add(id);
    return [{ type: 'usage', ...usage }];
  }

  /**
   * Сверка с итогом хода (`result.usage` — итог ЭТОГО хода, проверено записью CLI 2.1.310:
   * у двух ходов он одинаков, накапливается только `modelUsage`). Всё, что сообщениями хода не
   * покрыто (подагенты без потоковых событий, ходы без учёта), — одной строкой-остатком; итог
   * меньше насчитанного — молчим: отнимать уже записанное нечем.
   */
  private remainder(o: Json): AdapterEvent[] {
    const raw = isObject(o.usage) ? o.usage : null;
    const turn = [...this.turnSent].map((id) => this.usageById.get(id)!);
    this.turnSent = new Set();
    if (!raw) return [];
    const split = isObject(raw.cache_creation) ? raw.cache_creation : {};
    const sum = (pick: (u: TurnUsage) => number | undefined): number =>
      turn.reduce((acc, u) => acc + (pick(u) ?? 0), 0);
    const rest = {
      input: Math.max(0, num(raw.input_tokens) - sum((u) => u.input)),
      cacheRead: Math.max(0, num(raw.cache_read_input_tokens) - sum((u) => u.cacheRead)),
      cacheWrite: Math.max(0, num(raw.cache_creation_input_tokens) - sum((u) => u.cacheWrite)),
      cacheWrite1h: Math.max(0, num(split.ephemeral_1h_input_tokens) - sum((u) => u.cacheWrite1h)),
      output: Math.max(0, num(raw.output_tokens) - sum((u) => u.output)),
    };
    if (Object.values(rest).every((v) => v === 0)) return [];
    // Модель остатка известна, только когда в разговоре она была одна.
    const models = isObject(o.modelUsage) ? Object.keys(o.modelUsage) : [];
    this.remainders += 1;
    const tag = str(o.uuid) ?? `${this.conversation ?? 'session'}:${this.remainders}`;
    return [
      {
        type: 'usage',
        messageId: `result:${tag}`,
        ...rest,
        cacheWrite1h: Math.min(rest.cacheWrite1h, rest.cacheWrite),
        ...(models.length === 1 ? { model: models[0] } : {}),
        remainder: true,
      },
    ];
  }

  private streamEvent(o: Json): AdapterEvent[] {
    const event = isObject(o.event) ? o.event : {};
    const kind = event.type;
    if (kind === 'message_start') {
      const out = this.ensureTurn(o);
      const message = isObject(event.message) ? event.message : {};
      this.message = str(message.id) ?? str(o.api_message_id) ?? null;
      if (this.message)
        this.mergeUsage(this.message, message.usage, {
          ...(str(message.model) ? { model: str(message.model) } : {}),
          subagent: subagentLine(o),
        });
      return out;
    }
    if (kind === 'content_block_delta') {
      const delta = isObject(event.delta) ? event.delta : {};
      if (delta.type !== 'text_delta') return [];
      const out = this.ensureTurn(o);
      out.push({ type: 'text.delta', text: str(delta.text) ?? '' });
      return out;
    }
    if (kind === 'message_delta') {
      const id = str(o.api_message_id) ?? this.message;
      if (id) this.mergeUsage(id, event.usage, { subagent: subagentLine(o) });
      return [];
    }
    if (kind === 'message_stop') {
      return this.flushUsage(str(o.api_message_id) ?? this.message);
    }
    return [];
  }

  private assistant(o: Json): AdapterEvent[] {
    const message = isObject(o.message) ? o.message : {};
    const out = this.ensureTurn(o);
    const id = str(message.id);
    if (id)
      this.mergeUsage(id, message.usage, {
        ...(str(message.model) ? { model: str(message.model) } : {}),
        subagent: subagentLine(o),
      });
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_use') continue;
      out.push({
        type: 'tool.requested',
        toolUseId: str(block.id) ?? '',
        name: str(block.name) ?? '',
        input: block.input ?? {},
        cliInitiated: this.cliInitiated,
        // Вызов внутри подагента: CLI метит строку вызовом-родителем (R11); иначе главный контекст.
        parentToolUseId: subagentLine(o) ? (o.parent_tool_use_id as string) : null,
      });
    }
    return out;
  }

  private result(o: Json): AdapterEvent[] {
    // Ошибка исполнения без хода (возобновление пропавшего разговора): не уведомление CLI,
    // а отказ сессии — код по правилу переходника.
    if (this.turn === null && o.is_error === true && str(o.subtype)?.startsWith('error')) {
      const errors = Array.isArray(o.errors) ? o.errors.map(String) : [];
      const detail = errors.join('; ') || (str(o.subtype) as string);
      // Без эха ошибка отвечает на первую ждущую отправку: ход её не начнётся никогда, а
      // ждущая держала бы насос (`waiting > 0`) до конца сеанса (F-38).
      if (!this.rule.echo) this.pending.shift();
      return [{ type: 'error', code: this.rule.classifyError?.(detail) ?? 'model-error', detail }];
    }
    const out = this.ensureTurn(o);
    // Окно сессия называет только в итоге: сообщения хода, изданные без него, издаются снова
    // (замена по `messageId`), иначе первый ход сессии роста контекста не судил бы.
    this.learnWindows(o);
    for (const id of new Set([...this.turnMessages, ...(this.message ? [this.message] : [])])) {
      this.attachWindow(id);
      out.push(...this.flushUsage(id));
    }
    this.turnMessages = new Set();
    out.push(...this.remainder(o));
    const denials = Array.isArray(o.permission_denials)
      ? o.permission_denials.filter(isObject)
      : [];
    for (const d of denials) {
      const input = isObject(d.tool_input) ? d.tool_input : {};
      const toolUseId = str(d.tool_use_id);
      out.push({
        type: 'ask',
        ask: this.rule.mapPermission({ tool: str(d.tool_name) ?? '', input }),
        denied: true,
        ...(toolUseId ? { toolUseId } : {}),
      });
    }
    const numTurns = num(o.num_turns);
    const turn = this.turn;
    if (turn?.kind === 'core') {
      for (const t of [turn, ...turn.folded]) {
        this.ended.add(t.uuid);
        out.push({
          type: 'turn.ended',
          attribution: t.cmdId,
          origin: t.origin,
          isError: o.is_error === true,
          numTurns,
          text: str(o.result) ?? '',
        });
      }
    } else {
      out.push({
        type: 'turn.cli-initiated',
        cause: numTurns === 0 ? 'notification' : 'background-wake',
        numTurns,
      });
    }
    this.turn = null;
    this.message = null;
    return out;
  }
}
