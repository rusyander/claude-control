/**
 * Вкладка «API» окна «Окружение»: эндпоинты из контракта OpenAPI (файл проекта,
 * адрес работающего сервиса) или из коллекции Postman, отправка запроса через
 * сервер панели (без CORS) и сверка ответа со схемой контракта.
 */

export const API_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
export type ApiMethod = (typeof API_METHODS)[number];

/** Откуда эндпоинты: файл в проекте, адрес, коллекция Postman. */
export type ApiSourceKind = 'file' | 'url' | 'postman';

export interface ApiSource {
  /** `file:<путь от корня>`, `url:<адрес>`, `postman:<id>`. */
  id: string;
  kind: ApiSourceKind;
  /** Как показывать: путь файла, адрес или имя коллекции. */
  label: string;
  /** Добавлен человеком (адрес, коллекция) — его можно убрать; файл проекта — нет. */
  removable: boolean;
}

/** Работающая цель из «Dev-сервера» с известным портом — кандидат в базовый адрес. */
export interface ApiRunningService {
  name: string;
  url: string;
}

/** Адрес стенда из `.env`-файла проекта — кандидат в базовый адрес (секретные ключи не читаются). */
export interface ApiEnvUrl {
  url: string;
  /** Файл от корня проекта, с прямыми слэшами: `e2e/.env`. */
  file: string;
  /** Ключ строки: `DEV_API_URL`. */
  key: string;
  /** Из основной копии репозитория: проект — копия задачи, своего `.env` у неё нет. */
  main?: true;
}

export interface ApiExplorerInfo {
  sources: ApiSource[];
  services: ApiRunningService[];
  /** Адреса из `.env`-файлов проекта, в порядке файлов. */
  envUrls?: ApiEnvUrl[];
  /** Сохранённый базовый адрес запросов проекта. */
  baseUrl?: string;
  /** Заголовок авторизации сохранён (значение наружу не отдаётся). */
  auth?: { header: string; masked: string };
}

/** Схема из контракта, ссылки `$ref` подставлены; цикл обрезан `{ $circular: '<имя>' }`. */
export type ApiSchema = Record<string, unknown>;

export interface ApiParam {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  description?: string;
  schema?: ApiSchema;
  example?: unknown;
}

export interface ApiResponseSpec {
  /** `200`, `4XX`, `default`. */
  status: string;
  description?: string;
  contentType?: string;
  schema?: ApiSchema;
}

export interface ApiEndpoint {
  /** `GET /users/{id}` — ключ эндпоинта в источнике. */
  id: string;
  method: ApiMethod;
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  operationId?: string;
  deprecated?: boolean;
  params: ApiParam[];
  body?: { contentType: string; required: boolean; schema?: ApiSchema; example?: unknown };
  responses: ApiResponseSpec[];
  /** Только у запросов из Postman: заголовки и тело, сохранённые в коллекции. */
  preset?: { headers: [string, string][]; body?: string };
}

export interface ApiSpec {
  sourceId: string;
  title: string;
  version?: string;
  /** `3.1`, `3.0`, `2.0` (Swagger) или `postman`. */
  format: string;
  /** Адреса из `servers` (или `host`+`basePath` у Swagger). */
  servers: string[];
  endpoints: ApiEndpoint[];
  /** Что разобрать не удалось. Тексты — у клиента, по `code`. */
  warnings: ApiSpecWarning[];
}

export interface ApiSpecWarning {
  /**
   * `truncated` — эндпоинтов больше показанных; `cookie` / `form-data` — такие
   * параметры не показаны; `external-ref` — ссылка на другой файл не разобрана
   * (`detail` — сама ссылка); `postman-auth` — вид авторизации коллекции не
   * перенесён (`detail` — его имя); `postman-body` — тело form-data/файл не перенесено.
   */
  code: 'truncated' | 'cookie' | 'form-data' | 'external-ref' | 'postman-auth' | 'postman-body';
  count?: number;
  detail?: string;
}

/** Расхождение ответа со схемой: путь в JSON и что не так. */
export interface ApiSchemaIssue {
  /** `$.items[3].price` */
  path: string;
  kind: 'type' | 'required' | 'enum' | 'additional' | 'one-of' | 'format';
  /** Чего ждал контракт: тип, список значений, имя поля. */
  expected?: string;
  /** Что пришло: тип или значение коротко. */
  actual?: string;
}

export interface ApiSchemaCheck {
  /**
   * `ok` — совпало; `mismatch` — есть расхождения; `no-schema` — у этого кода
   * в контракте нет схемы тела; `undocumented-status` — код ответа в контракте
   * не описан; `not-json` — ждали JSON, пришло другое.
   */
  verdict: 'ok' | 'mismatch' | 'no-schema' | 'undocumented-status' | 'not-json';
  /** С каким ответом контракта сверяли: `200`, `2XX`, `default`. */
  against?: string;
  issues: ApiSchemaIssue[];
  /** Расхождений больше показанных. */
  truncated?: boolean;
}

export interface ApiSendResult {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  /** Тело длиннее предела — показано начало. */
  bodyTruncated: boolean;
  /** Картинка, архив, PDF — тело не показываем текстом, только размер. */
  binary?: boolean;
  sizeBytes: number;
  durationMs: number;
  contentType?: string;
  /** Итоговый адрес запроса — как его увидел сервер. */
  url: string;
  check?: ApiSchemaCheck;
}

/** Запрос в истории: заголовки авторизации замаскированы, тело — до 20 000 знаков. */
export interface ApiHistoryEntry {
  id: string;
  at: string;
  method: ApiMethod;
  url: string;
  sourceId?: string;
  endpointId?: string;
  headers: [string, string][];
  body?: string;
  status?: number;
  durationMs?: number;
  verdict?: ApiSchemaCheck['verdict'];
  /** Сеть не ответила: отказ соединения, таймаут. */
  error?: string;
}
