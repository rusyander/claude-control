import type { RouteReply, RouteRequest, SseFrame } from '../index.d.mts';

/** Вызов, как его видит свип: что именно ушло наверх. */
export interface ContourCall {
  method: string;
  path: string;
  /** Строка запроса с `?` или пусто. */
  search: string;
  authorization: string | string[] | undefined;
  apiKey: string | string[] | undefined;
  anthropicVersion: string | string[] | undefined;
  tenant: string | string[] | undefined;
  body: string;
}

export interface ContourOptions {
  port?: number;
  /** Сценарий по умолчанию; имя модели `stub-<сценарий>` его перекрывает. */
  scenario?: string;
  delayMs?: number;
  png?: string;
  vendorPrefix?: string;
}

export interface ContourStub {
  url: string;
  port: number;
  calls: ContourCall[];
  close: () => Promise<void>;
}

export interface ContourModel {
  id: string;
  kind: 'chat' | 'embedding';
  owned_by: string;
  context_length?: number;
  max_output_tokens?: number;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  image_generation?: boolean;
}

export const MODELS: readonly ContourModel[];
export const SCENARIOS: ReadonlySet<string>;
export const REFUSALS: Readonly<Record<string, unknown>>;
export const REWRITTEN_FINAL: string;
export const NATIVE_TEXT: string;
export const PNG_1X1: string;
export const DECK_JSON: {
  title: string;
  subtitle: string;
  slides: { title: string; bullets: string[]; notes: string }[];
};
export function scenarioFor(model: unknown, fallback: string): string;
export function streamFrames(
  scenario: string,
  model: string,
  rawBody?: string,
  png?: string,
): SseFrame[];
export function wholeBody(
  scenario: string,
  model: string,
  rawBody?: string,
  png?: string,
): Record<string, unknown>;
export function contourRoute(
  options?: Omit<ContourOptions, 'port'> & { calls?: ContourCall[] },
): (request: RouteRequest) => RouteReply | undefined;
export function startContourStub(options?: ContourOptions): Promise<ContourStub>;
