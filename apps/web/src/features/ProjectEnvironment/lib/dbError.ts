import axios from 'axios';
import type { TFunction } from 'i18next';
import { toErrorMessage } from '@shared/api/toErrorMessage';

/**
 * Отказ маршрутов базы → текст окна. Сервер шлёт свой `code` (а для ошибок
 * Postgres — `kind`, SQLSTATE и позицию) без `messageCode`: тексты здесь, на
 * двух языках.
 */

export interface DbErrorView {
  /** Сторож не пропустил запрос — до базы он не дошёл. */
  refused: boolean;
  message: string;
  hint?: string;
  /** Позиция ошибки в тексте запроса, с 1 — редактор ставит туда курсор. */
  position?: number;
  sqlState?: string;
}

interface ErrorBody {
  code?: string;
  kind?: string;
  message?: string;
  position?: number;
  sqlState?: string;
  refusal?: { reason?: string; word?: string; name?: string };
}

const HINTS: Record<string, string> = {
  connect: 'environment.database.errors.connectHint',
  auth: 'environment.database.errors.authHint',
  timeout: 'environment.database.errors.timeoutHint',
};

export function dbErrorView(error: unknown, t: TFunction): DbErrorView {
  const data: unknown = axios.isAxiosError(error) ? error.response?.data : undefined;
  const body: ErrorBody = typeof data === 'object' && data !== null ? (data as ErrorBody) : {};
  const message = body.message ?? toErrorMessage(error);

  switch (body.code) {
    case 'db-sql-refused': {
      const refusal = body.refusal ?? {};
      return {
        refused: true,
        message: t(`environment.database.refused.${refusal.reason ?? 'empty'}`, {
          word: refusal.word ?? '',
          name: refusal.name ?? '',
        }),
      };
    }
    case 'db-error': {
      const kind = body.kind ?? 'query';
      return {
        refused: false,
        message: t(`environment.database.errors.${kind}`, { message }),
        ...(HINTS[kind] ? { hint: t(HINTS[kind]) } : {}),
        ...(body.position ? { position: body.position } : {}),
        ...(body.sqlState ? { sqlState: body.sqlState } : {}),
      };
    }
    case 'db-project-unregistered':
      return { refused: false, message: t('environment.database.errors.unregistered') };
    case 'db-connection-unknown':
      return { refused: false, message: t('environment.database.errors.unknown') };
    case 'db-connection-not-manual':
      return { refused: false, message: t('environment.database.errors.notManual') };
    default:
      return { refused: false, message: t('environment.database.errors.generic', { message }) };
  }
}

/** Номер строки (с 1) для позиции Postgres (с 1, в символах). */
export function lineOfPosition(sql: string, position: number): number {
  return sql.slice(0, Math.max(0, position - 1)).split('\n').length;
}

/** Код ответа отказа без разбора — окну нужно отличить «чужой проект» от прочего. */
export function dbErrorCode(error: unknown): string | undefined {
  const data: unknown = axios.isAxiosError(error) ? error.response?.data : undefined;
  return typeof data === 'object' && data !== null
    ? ((data as { code?: unknown }).code as string | undefined)
    : undefined;
}

/** Запрос к таблице для вставки в редактор: имена в кавычках, если нужно. */
export function tableQuery(schema: string, name: string): string {
  const quote = (value: string): string =>
    /^[a-z_][a-z0-9_]*$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
  const qualified = schema === 'public' ? quote(name) : `${quote(schema)}.${quote(name)}`;
  return `SELECT * FROM ${qualified} LIMIT 100`;
}
