import type {
  ComposePort,
  ComposeServiceState,
  DbConnection,
  DbUnsupported,
} from '@agentdeck/contracts';

/** Подключение с паролем — живёт только на сервере; наружу уходит `info`. */
export interface ResolvedConnection {
  info: DbConnection;
  password?: string;
}

/** Реквизиты, разобранные из адреса или набора переменных, до привязки к источнику. */
export interface DbTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
}

/** Разбор адреса: Postgres — реквизиты, иначе — имя движка, который панель не читает. */
export type ParsedTarget =
  { kind: 'postgres'; target: DbTarget } | { kind: 'other'; engine: string };

/** Сервис Compose глазами вкладки «База данных»: состав из файла и живое состояние. */
export interface ComposeDbService {
  name: string;
  image?: string;
  ports: ComposePort[];
  environment: Record<string, string>;
  state?: ComposeServiceState;
}

export interface ComposeDbInput {
  /** Файл относительно корня проекта — для подписи «откуда». */
  file: string;
  services: ComposeDbService[];
}

export interface FoundSources {
  connections: ResolvedConnection[];
  unsupported: DbUnsupported[];
}
