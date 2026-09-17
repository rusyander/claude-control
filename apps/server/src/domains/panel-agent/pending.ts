import { randomUUID } from 'node:crypto';
import type {
  PanelActionPreview,
  PanelActionRisk,
  PanelPendingAction,
} from '@agentdeck/contracts/panel-agent';

/**
 * Чем закончилось ожидание карточки. `approve`/`reject` — клик человека,
 * `timeout` — клика не было, `cancelled` — переходник ушёл раньше решения.
 */
export type PendingSettlement = 'approve' | 'reject' | 'timeout' | 'cancelled';

export interface PendingRequest {
  name: string;
  risk: Exclude<PanelActionRisk, 'read'>;
  conversationId?: string;
  preview: PanelActionPreview;
  /** Отпечаток состояния под карточкой; в `PanelPendingAction` не попадает — окну он не нужен. */
  fingerprint?: string;
}

export interface PendingHandle {
  pending: PanelPendingAction;
  /** Отпечаток на момент показа — сверяется перед исполнением одобренной карточки. */
  fingerprint?: string;
  /** Разрешится ровно один раз — первым из четырёх исходов. */
  settled: Promise<PendingSettlement>;
}

/** Итог попытки решить карточку по id. */
export type DecideResult = 'ok' | 'not-found' | 'already-decided';

interface Entry {
  pending: PanelPendingAction;
  resolve: (settlement: PendingSettlement) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Сколько помним уже решённые id. Нужно ровно для 409: второй клик по той же
 * карточке (окно в двух вкладках, телефон рядом с ноутбуком) должен услышать
 * «уже решено», а не «такого нет» — иначе человек решит, что клик потерялся.
 */
const SETTLED_MEMORY = 500;

/**
 * Карточки подтверждения, ждущие клика человека.
 *
 * Живут в памяти процесса, а не на диске, и это осознанно: карточку держит
 * открытый запрос переходника. Панель перезапустилась — запроса больше нет,
 * агенту отвечать некому, и восстановленная из файла карточка выполнила бы
 * действие, о результате которого никто не узнает.
 *
 * Исход у карточки ровно один: таймер, клик и обрыв соревнуются, и побеждает
 * первый — остальные видят «уже решено». Отсюда 409 на повторный клик.
 */
export class PanelPendingActions {
  private readonly open = new Map<string, Entry>();
  private readonly settled = new Map<string, PendingSettlement>();
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  /** Завести карточку. Ожидание начинается сразу: таймер взведён до ответа. */
  create(request: PendingRequest): PendingHandle {
    const now = Date.now();
    const pending: PanelPendingAction = {
      id: randomUUID(),
      name: request.name,
      risk: request.risk,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      preview: request.preview,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.timeoutMs).toISOString(),
    };

    let resolve!: (settlement: PendingSettlement) => void;
    const settled = new Promise<PendingSettlement>((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => this.settle(pending.id, 'timeout'), this.timeoutMs);
    // Ждущая карточка не должна держать процесс живым на выходе.
    timer.unref?.();
    this.open.set(pending.id, { pending, resolve, timer });
    return {
      pending,
      settled,
      ...(request.fingerprint === undefined ? {} : { fingerprint: request.fingerprint }),
    };
  }

  /** Все ждущие, старые первыми — порядок, в котором их задавал агент. */
  list(): PanelPendingAction[] {
    return [...this.open.values()].map((entry) => entry.pending);
  }

  /** Ждущая карточка по id; решённая или неизвестная — `undefined`. */
  get(id: string): PanelPendingAction | undefined {
    return this.open.get(id)?.pending;
  }

  /** Есть ли ждущая карточка у разговора — пока она висит, ход агента не снимается по сроку. */
  hasOpenFor(conversationId: string): boolean {
    return [...this.open.values()].some((entry) => entry.pending.conversationId === conversationId);
  }

  /** Клик человека. */
  decide(id: string, decision: 'approve' | 'reject'): DecideResult {
    if (this.open.has(id)) {
      this.settle(id, decision);
      return 'ok';
    }
    return this.settled.has(id) ? 'already-decided' : 'not-found';
  }

  /** Переходник оборвал запрос: карточка снимается, действие не выполняется. */
  cancel(id: string): void {
    this.settle(id, 'cancelled');
  }

  /** Выход панели: ответить всем ждущим, чтобы ни один запрос не повис. */
  cancelAll(): void {
    for (const id of [...this.open.keys()]) this.settle(id, 'cancelled');
  }

  private settle(id: string, how: PendingSettlement): void {
    const entry = this.open.get(id);
    if (!entry) return;
    this.open.delete(id);
    clearTimeout(entry.timer);
    this.settled.set(id, how);
    if (this.settled.size > SETTLED_MEMORY) {
      const oldest = this.settled.keys().next().value;
      if (oldest !== undefined) this.settled.delete(oldest);
    }
    entry.resolve(how);
  }
}
