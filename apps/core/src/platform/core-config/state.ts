import type { Fact } from '@agentdeck/contracts/core/facts';
import { z } from 'zod';
import { readBytesSync } from '../safe-io/files.ts';

/**
 * `config.state.json` — память писателя настройки (00:58, G6, P47): отпечаток последнего
 * `config.json`, записанного ядром; запись в полёте (`pending` — пишется ДО самого файла, чтобы
 * крах между ними читался как восстановление, а не как правка мимо API); последние ключи повтора
 * `cmdId` с исходом — тот же ключ отвечает прежним исходом, без второй записи.
 */

export const CONFIG_CMDS_MAX = 100;

const sha = z.string().regex(/^[0-9a-f]{64}$/);

const warningSchema = z.strictObject({ section: z.string(), detail: z.string() });
export type ConfigWarning = z.infer<typeof warningSchema>;

export const configCmdSchema = z.strictObject({
  cmdId: z.string().min(1),
  digest: sha,
  at: z.number(),
  /** Чем человек доказан (`nonce+peer` / `device-signature`). */
  by: z.string(),
  warnings: z.array(warningSchema),
});
export type ConfigCmd = z.infer<typeof configCmdSchema>;

export const configStateSchema = z.strictObject({
  v: z.literal(1),
  /** Отпечаток последнего `config.json`, записанного ядром (= `config.last.json`). */
  digest: sha,
  /** Запись в полёте: файл может уже нести её отпечаток. */
  pending: configCmdSchema.optional(),
  /** Файл до этапа 7 принят при загрузке (G6) — когда. */
  adoptedAt: z.number().optional(),
  cmds: z.array(configCmdSchema).max(CONFIG_CMDS_MAX),
});
export type ConfigState = z.infer<typeof configStateSchema>;

/** Нет файла — `absent` (настройку ядро ещё не писало); не тот — `unknown`, не «нет». */
export function readConfigState(path: string): Fact<ConfigState> {
  const bytes = readBytesSync(path);
  if (!('value' in bytes)) return bytes;
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.value.toString('utf8'));
  } catch (error) {
    return { unknown: `config.state.json not JSON: ${(error as Error).message}` };
  }
  const parsed = configStateSchema.safeParse(raw);
  if (!parsed.success) {
    return { unknown: `config.state.json: ${parsed.error.issues[0]?.message ?? 'rejected'}` };
  }
  return { value: parsed.data };
}
