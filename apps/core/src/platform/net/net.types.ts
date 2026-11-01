/**
 * Типы сетевого слоя к внешним адресам (ключ API, шлюз контура): свой корень доверия компании и
 * прокси из окружения. Петля этой машины — `platform/http-json.ts`, сюда не относится.
 */

/** Окружение, из которого читается прокси; в тестах — подставной объект, не `process.env`. */
export type ProxyEnv = Record<string, string | undefined>;

export type ProxyRoute =
  | { kind: 'direct' }
  | { kind: 'proxy'; url: URL; source: string }
  /** Прокси назван, но не HTTP или не разбирается: отказ, а не прямой выход «чтобы работало». */
  | { kind: 'unsupported'; value: string; source: string };

/** Та часть `fetch`, которой пользуются маршруты: `globalThis.fetch` ей соответствует. */
export type NetFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** Коды отказов сети: в причину факта уходит код и английский текст, без ключей и паролей. */
export type NetErrorCode =
  | 'ca-unreadable'
  | 'ca-not-certificate'
  | 'proxy-unsupported'
  | 'proxy-unreachable'
  | 'proxy-timeout'
  | 'proxy-login'
  | 'proxy-refused'
  | 'aborted';
