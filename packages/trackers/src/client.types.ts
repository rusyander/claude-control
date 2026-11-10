import type { TrackerResponse } from './index.ts';

/** Вид установки Atlassian: облако или своя (Server/DC) — от него зависят путь и авторизация. */
export type TrackerDeployment = 'cloud' | 'server';

/** Сайт трекера без учётных данных: этого клиенту хватает, чтобы собрать адрес. */
export interface TrackerSite {
  /** Корень сайта без хвостового слэша (`https://tracker.example.com`). */
  baseUrl: string;
  deployment: TrackerDeployment;
}

/** Учётные данные — только для `sendOver`; дальше замыкания порта они не уходят. */
export interface TrackerCredentials {
  deployment: TrackerDeployment;
  /** Почта учётки облака; своей установке не нужна. */
  email: string;
  token: string;
}

/** Запрос, каким его видит транспорт: заголовки (с авторизацией) уже собраны портом. */
export interface TransportRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  headers: Record<string, string>;
  body?: string;
  system: string;
}

/**
 * Транспорт: панель — `sendRequest` (потолок ожидания, один повтор), ядро — своя сеть. Бросает
 * только когда до трекера не дошли вовсе.
 */
export type TrackerTransport = (request: TransportRequest) => Promise<TrackerResponse>;
