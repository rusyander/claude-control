/** Разобранный JSON/YAML контракта — дерево без схемы. */
export type JsonNode = Record<string, unknown>;

/** Контракт не прочитан: не JSON/YAML, не OpenAPI/Swagger/Postman, адрес не ответил. */
export class ApiSpecError extends Error {
  kind: 'unreadable' | 'not-a-spec' | 'fetch' | 'too-big' | 'missing';
  constructor(kind: ApiSpecError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Запрос не ушёл или не вернулся: адрес не тот, соединение отказано, вышло время. */
export class ApiSendError extends Error {
  kind: 'bad-url' | 'connect' | 'timeout';
  /** Код ошибки сети, имя заголовка, секунды — подставляется в текст клиента. */
  detail?: string;
  constructor(kind: ApiSendError['kind'], message: string, detail?: string) {
    super(message);
    this.kind = kind;
    if (detail) this.detail = detail;
  }
}

export const isNode = (value: unknown): value is JsonNode =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
