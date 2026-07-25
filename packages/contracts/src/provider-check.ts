import { object, string, array, record, literal, union, type infer as Infer } from 'zod';

/**
 * Проверка провайдера — «доверие, подтверждённое делом».
 *
 * Все провайдеры кроме Claude помечены `experimental`: их форматы собраны по
 * документации и прогнаны тестами, но на живой машине пользователя ни разу не
 * исполнялись. Бейдж «экспериментальный» честен, однако он не меняется НИКОГДА,
 * даже когда у человека всё работает. Проверка закрывает этот разрыв: панель
 * прогоняет по провайдеру короткий список шагов на РЕАЛЬНОЙ машине и, если всё
 * сошлось, помечает его проверенным — «проверено здесь», а не «обещано в коде».
 *
 * Что важно в устройстве проверки:
 * - запись НИКОГДА не идёт в настоящие файлы пользователя. Круг «прочитали →
 *   записали → прочитали» выполняется на ВРЕМЕННОЙ КОПИИ конфигурации, копия
 *   удаляется. Иначе проверка сама портила бы то, что проверяет;
 * - шаги, для которых у провайдера нет возможности (`unsupported`), не
 *   «проваливаются», а честно помечаются пропущенными;
 * - запуск ассистента — отдельный шаг: он расходует лимиты пользователя, идёт
 *   строго по кнопке и его можно отключить.
 */

/** Шаг проверки. */
export type ProviderCheckStepId =
  /** Бинарь CLI найден в PATH. */
  | 'cli'
  /** Файлы/каталоги конфигурации провайдера существуют. */
  | 'config'
  /** Круг чтения-записи MCP-серверов на копии конфигурации. */
  | 'mcp'
  /** Круг чтения-записи прав на копии конфигурации. */
  | 'permissions'
  /** Круг чтения-записи переменных окружения на копии конфигурации. */
  | 'env'
  /** Круг чтения-записи глобальных инструкций на копии конфигурации. */
  | 'instructions'
  /** Один настоящий запуск ассистента провайдера. */
  | 'assistant';

/**
 * Итог шага. `warn` — не отказ, а «работает, но не полностью» (например, CLI не
 * стоит: разделы конфигурации от этого не ломаются, ограничен только запуск).
 */
export type ProviderCheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface ProviderCheckStep {
  id: ProviderCheckStepId;
  status: ProviderCheckStatus;
  /** Пояснение для человека: что именно проверено или почему пропущено. */
  detail: string;
  /** Файл, на копии которого шёл круг записи (для «где это лежит»). */
  filePath?: string;
}

/**
 * Уровень доверия по итогам последней проверки:
 * - `verified` — прошли все шаги, включая запуск ассистента;
 * - `partial` — отказов нет, но что-то пропущено (нет CLI, ассистент выключен);
 * - `failed` — хотя бы один шаг провалился.
 */
export type ProviderCheckLevel = 'verified' | 'partial' | 'failed';

export interface ProviderCheckResult {
  provider: string;
  providerName: string;
  /** Когда проверка выполнена, ISO. */
  at: string;
  level: ProviderCheckLevel;
  steps: ProviderCheckStep[];
}

/** Ответ `GET /api/providers/checks`: id провайдера → последний итог. */
export interface ProviderChecksResponse {
  checks: Record<string, ProviderCheckResult>;
}

/** Тело `POST /api/providers/:id/check`. */
export interface ProviderCheckRequest {
  /** Запускать ли настоящий вызов ассистента (по умолчанию да). */
  assistant?: boolean;
}

const stepSchema = object({
  id: union([
    literal('cli'),
    literal('config'),
    literal('mcp'),
    literal('permissions'),
    literal('env'),
    literal('instructions'),
    literal('assistant'),
  ]),
  status: union([literal('pass'), literal('warn'), literal('fail'), literal('skipped')]),
  detail: string(),
  filePath: string().optional(),
});

/** Схема сохранённого итога — импорт состояния с чужой машины ей проверяется. */
export const providerCheckResultSchema = object({
  provider: string(),
  providerName: string(),
  at: string(),
  level: union([literal('verified'), literal('partial'), literal('failed')]),
  steps: array(stepSchema),
});

export const providerChecksSchema = record(string(), providerCheckResultSchema);

export type ProviderCheckResultInput = Infer<typeof providerCheckResultSchema>;
