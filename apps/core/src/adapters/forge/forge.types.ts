import type { ForgeProject } from '@agentdeck/contracts/core/forge';
import type { NetFetch } from '../../platform/net/net.types.ts';

/**
 * Доступ переходника к форжу: проект (вид, адрес сайта, ссылка на проект), значение доступа и
 * транспорт. Значение доступа живёт только здесь и в заголовке запроса — в журнал, след и
 * причину факта оно не попадает (05:3, P63 соседний: учётка называется видом, не значением).
 */
export interface ForgeAccess {
  project: ForgeProject;
  /** `null` — доступа нет: каждое чтение `unknown('no credential')`, запись тоже. */
  token: string | null;
  /** Почему доступа нет, если причина не «ключ не сохранён» (хранилище не прочиталось). */
  tokenProblem?: string;
  /** `createCaFetch` платформы (свой корень доверия, прокси); тест — заглушка на loopback. */
  fetch: NetFetch;
  /** Срок одного запроса; по умолчанию — срок классов чтения форжа (30 с). */
  timeoutMs?: number;
}

/** Исход одного HTTP-запроса к форжу, без решения «есть / нет» — его принимает метод порта. */
export type ForgeReply =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'text'; status: number; text: string }
  /** 4xx: ответ форжа есть, но не успех — 404 метод может прочитать как «нет». */
  | { kind: 'status'; status: number; message: string }
  /** Сеть, срок, 5xx, мусор вместо JSON: исход не узнан. */
  | { kind: 'unknown'; reason: string };

export interface ForgeCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Путь от корня API (`/projects/…`, `/repos/…`) или полный адрес (GraphQL). */
  url: string;
  body?: unknown;
  /** `text` — лог задания: тело не JSON по природе. */
  accept?: 'json' | 'text';
}
