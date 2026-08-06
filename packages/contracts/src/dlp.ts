import { object, string, boolean, number, array, enum as zodEnum, type infer as Infer } from 'zod';

/**
 * Защита данных — локальный прокси между CLI и моделью.
 *
 * CLI ходит в модель по адресу; если этот адрес указать на прокси панели
 * (профилем «своего эндпоинта»), панель видит ТЕЛО каждого запроса: промпт,
 * содержимое прочитанных агентом файлов, вывод инструментов. По правилам она
 * либо заменяет найденное на метку (`[ИМЯ_1]`) с обратной подстановкой в
 * ответе, либо отклоняет запрос целиком.
 *
 * Три вещи, которые нельзя перепутать (панель обязана говорить о них прямо):
 * свой эндпоинт решает, КУДА уходит запрос; прокси — ЧТО в нём уходит; гейт на
 * промпте видит только то, что человек набрал руками.
 */

/** Что делать с найденным. */
export const dlpActions = ['mask', 'block', 'flag'] as const;
export type DlpAction = (typeof dlpActions)[number];

/** Откуда правило берёт совпадения. */
export const dlpRuleKinds = ['builtin', 'terms', 'regex'] as const;
export type DlpRuleKind = (typeof dlpRuleKinds)[number];

/**
 * Встроенные образцы. Каждый — с проверкой контрольной суммы там, где она у
 * формата есть (ИНН, СНИЛС, номер карты): без неё правило ловило бы любое
 * число подходящей длины, а ложное срабатывание в DLP хуже пропуска — оно
 * ломает работу и учит выключать защиту.
 */
export const dlpBuiltinPatterns = [
  'email',
  'phone_ru',
  'inn',
  'snils',
  'card',
  'secret_key',
] as const;
export type DlpBuiltinPattern = (typeof dlpBuiltinPatterns)[number];

export const dlpRuleSchema = object({
  id: string().min(1),
  name: string().min(1),
  enabled: boolean().default(true),
  kind: zodEnum(dlpRuleKinds),
  /** `kind: 'builtin'` — какой из встроенных образцов. */
  builtin: zodEnum(dlpBuiltinPatterns).optional(),
  /**
   * `kind: 'terms'` — свой словарь: ФИО сотрудников, названия проектов, адреса.
   * Ищется без учёта регистра, целыми словами.
   */
  terms: array(string()).default([]),
  /** `kind: 'regex'` — своё выражение. Разбирается на сервере до сохранения. */
  pattern: string().default(''),
  action: zodEnum(dlpActions).default('mask'),
  /** Метка замены: `ИМЯ` → `[ИМЯ_1]`, `[ИМЯ_2]`, … */
  label: string().default('ДАННЫЕ'),
});

export type DlpRule = Infer<typeof dlpRuleSchema>;

/** Настройки прокси. Правила и словари живут ОТДЕЛЬНО — в них сами данные. */
export const dlpSettingsSchema = object({
  enabled: boolean().default(false),
  /** Порт слушателя на 127.0.0.1. Наружу не публикуется никогда. */
  port: number().int().min(1024).max(65535).default(5179),
  /**
   * Куда пересылать. Пусто — адрес берётся из профиля эндпоинта
   * `upstreamProfileId`; если пусто и то и другое, прокси не поднимается:
   * гадать про облако вендора нельзя.
   */
  upstreamUrl: string().default(''),
  upstreamProfileId: string().default(''),
  /**
   * Что делать с запросом, тело которого панель не разобрала (незнакомый путь
   * или форма). По умолчанию — отклонять: прокси, молча пропускающий то, чего
   * не понял, опаснее его отсутствия, потому что создаёт ложное спокойствие.
   */
  passUnknown: boolean().default(false),
  /** Вести журнал срабатываний (значений в нём нет никогда). */
  journal: boolean().default(true),
});

export type DlpSettings = Infer<typeof dlpSettingsSchema>;

/** Одно срабатывание правила — для журнала и для ответа панели. */
export interface DlpHit {
  ruleId: string;
  ruleName: string;
  action: DlpAction;
  /** Метка, которой заменено (`[ИМЯ_1]`). У `block` и `flag` пусто. */
  placeholder: string;
  /** Сколько раз встретилось. Самого значения нет НИГДЕ. */
  count: number;
}

/** Запись журнала. Значений и секретов не содержит по построению. */
export interface DlpJournalEntry {
  at: string;
  /** Куда стучался CLI: путь запроса (`/v1/messages`). */
  path: string;
  apiKind: string;
  decision: 'passed' | 'masked' | 'blocked';
  /** Байт в теле запроса — видно, что вообще уходило. */
  bytes: number;
  hits: DlpHit[];
  /** Почему отклонено, если отклонено. */
  reason?: string;
}

/** Состояние прокси для панели. */
export interface DlpStatus {
  running: boolean;
  /** Адрес, который вписывают в CLI (`http://127.0.0.1:5179`). */
  address: string;
  /** Куда пересылает — уже разрешённый адрес, без токена. */
  upstream: string;
  /** Почему не поднялся, если не поднялся. */
  error?: string;
  /** Сколько запросов прошло с момента запуска. */
  requests: number;
  masked: number;
  blocked: number;
}

/** Ответ `GET /api/dlp`: настройки, правила, состояние. */
export interface DlpInfo {
  settings: DlpSettings;
  rules: DlpRule[];
  status: DlpStatus;
}

/** Ответ проверки правил на пробном тексте — предпросмотр без сети. */
export interface DlpPreviewResult {
  /** Текст после замены — его и увидела бы модель. */
  masked: string;
  hits: DlpHit[];
  /** Запрос был бы отклонён целиком. */
  blocked: boolean;
}
