import { z } from 'zod';

/**
 * Идентификаторы ядра (01 §Commands, P49): каждый id — задачи, единицы, шага, сессии, прогона
 * проверки, вопроса, действия, ресурса, команды — UUIDv7, выданный ДО любого запуска. Ни
 * временных ключей, ни ключей по времени, ни двух написаний одной сущности: схема ниже —
 * единственная форма, и каждое поле `*Id` в схемах журнала и команд построено на ней.
 */
export const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const uuidv7 = z.string().regex(UUIDV7_PATTERN, 'uuidv7');

export function isUuidv7(value: unknown): value is string {
  return typeof value === 'string' && UUIDV7_PATTERN.test(value);
}

/**
 * Имя из реестра (переходник CLI, маршрут модели, модель, усилие). Ядро работает с любым
 * провайдером, поэтому имена — данные реестра, который наполняют переходники, а не закрытый
 * список в контракте (владелец, 28.10).
 */
export const registryId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w.:/@+-]+$/, 'registry-id');

/** sha256 в hex — отпечатки профиля, слоя пользователя, артефактов. */
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'sha256');

export type TaskId = string;
export type UnitId = string;
export type StepId = string;
export type SessionId = string;
export type ActionId = string;
export type CommandId = string;
