import { z } from 'zod';

/**
 * Надзор панели за процессом ядра (этап 10, `ensureCore`): ядро — отдельный процесс, переживает
 * панель; панель поднимает его, если его нет, и перезапускает с отступом. Состояние отдаётся на
 * `/api/core/supervisor` — карточка сбоя читает его, а не угадывает по отказу прокладки.
 */

export const CORE_SUPERVISOR_STATES = ['starting', 'up', 'restarting', 'fault'] as const;
export type CoreSupervisorState = (typeof CORE_SUPERVISOR_STATES)[number];

export const coreSupervisorStateSchema = z.strictObject({
  state: z.enum(CORE_SUPERVISOR_STATES),
  pid: z.number().int().positive().nullable(),
  /** Перезапусков внутри окна отступа (5 за 10 минут — `fault`). */
  restarts: z.number().int().nonnegative(),
  lastExit: z
    .strictObject({
      code: z.number().int().nullable(),
      signal: z.string().nullable(),
      at: z.string().min(1),
    })
    .nullable(),
  nextRetryAt: z.string().nullable(),
  /** Хвост журнала для карточки сбоя; секреты замаскированы `@agentdeck/dlp/secret-mask`. */
  logTail: z.array(z.string()).max(40),
  autostart: z.enum(['on', 'off', 'unsupported']),
});
export type CoreSupervisorStatus = z.infer<typeof coreSupervisorStateSchema>;

/**
 * Коды отказа прокладки `/api/core/*`. `core-absent` называл `pnpm core` — после надзора панель
 * поднимает ядро сама: пока поднимается — `core-starting`, сдалась — `core-fault`.
 */
export const CORE_PROXY_CODES = [
  'core-absent',
  'core-unverified',
  'core-unreachable',
  'core-starting',
  'core-fault',
] as const;
export type CoreProxyCode = (typeof CORE_PROXY_CODES)[number];

/**
 * Итог выхода ядра в его доме: `{pid, code, signal, at}`, пишет само ядро на выходе. Панель на
 * Windows поднимает ядро не своим ребёнком и кода выхода не видит — карточка сбоя берёт его здесь.
 */
export const CORE_EXIT_FILE = 'core.exit.json';

/**
 * Код выхода ядра «дом уже занят живым ядром» (`CoreHomeBusy`, `apps/core/src/index.ts`): второе
 * ядро того же дома уходит на загрузке. Надзор панели по нему отличает лишнее ядро от падения и
 * усыновляет первое, а не копит неудачи до карточки сбоя.
 */
export const CORE_HOME_BUSY_EXIT = 3;

/**
 * Окружение ядра: `'0'` — уйти из занятого дома с кодом 0, а не 3. Так его запускает автозапуск
 * ОС: systemd (`Restart=on-failure`) и launchd (`SuccessfulExit=false`) перезапускают ядро на
 * ненулевом выходе, и лишнее ядро при живом первом крутилось бы без конца.
 */
export const CORE_BUSY_EXIT_ENV = 'AGENTDECK_CORE_BUSY_EXIT';
