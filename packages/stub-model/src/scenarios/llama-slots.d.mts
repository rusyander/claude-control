import type { RouteReply, RouteRequest, Script, StubModel } from '../index.d.mts';

/** Шаг ленты сервера моделей: что увидит один опрос `/health` + `/slots`. */
export interface LlamaStep {
  /** `ok` — 200, `loading` — 503 «Loading model», `down` — 500 (сервера нет). */
  health: 'ok' | 'loading' | 'down';
  /** Слот 0: занят ли, сколько промпта прочитано, сколько токенов ответа выдано. */
  slot?: { processing: boolean; filled?: number; decoded?: number };
  /** Сколько опросов шаг держится; по умолчанию один. */
  repeat?: number;
}

export interface LlamaHits {
  health: number;
  slots: number;
  count: number;
}

export interface LlamaSlotsOptions {
  timeline?: LlamaStep[];
  /** Окно слота (`n_ctx`), по умолчанию 8192. */
  nCtx?: number;
  /**
   * Ответ `count_tokens`; функция — итог по телу запроса подсчёта (свой у каждого запроса в
   * полёте); нет — счёт пакета (длина тела / 4).
   */
  promptTotal?: number | ((body: unknown) => number);
  hits?: LlamaHits;
}

export interface LlamaSlotsFacet {
  route: (request: RouteRequest) => RouteReply | undefined;
  hits: LlamaHits;
  play(timeline: LlamaStep[]): void;
}

export function llamaSlotsRoute(options?: LlamaSlotsOptions): LlamaSlotsFacet;

export interface LlamaSlotsStub {
  stub: StubModel;
  url: string;
  port: number;
  hits: LlamaHits;
  play(timeline: LlamaStep[]): void;
  close(): Promise<void>;
}

export function startLlamaSlotsStub(
  options?: LlamaSlotsOptions & {
    port?: number;
    trace?: string;
    models?: string[];
    script?: Script;
    /** Видит каждый запрос до путей грани (сырые заголовки и тело). */
    observe?: (request: RouteRequest) => void;
  },
): Promise<LlamaSlotsStub>;
