import type { CoreSupervisorStatus } from '@agentdeck/contracts/core/supervisor';

/** Что панель видит в доме ядра прямо сейчас (строка `procs.json` + сверка ОС). */
export type CoreProbe =
  | { kind: 'up'; pid: number }
  /** Строка есть, процесс жив, но порт не подтвердился: ядро ещё поднимается или самозванец. */
  | { kind: 'unverified'; pid: number; reason: string }
  | { kind: 'absent'; reason: string };

export interface CoreExit {
  code: number | null;
  signal: string | null;
}

/** Поднятое панелью ядро: pid и, где ОС его отдаёт, обещание выхода с кодом. */
export interface SpawnedCore {
  pid: number;
  /** POSIX: ребёнок с ручкой — код выхода. Windows через PowerShell — ручки нет, только опрос. */
  exited?: Promise<CoreExit>;
}

export interface CoreSupervisorTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CoreSupervisorDeps {
  probe(): Promise<CoreProbe>;
  /** Отвязанный запуск: своя группа процессов, переживает панель. */
  spawn(): Promise<SpawnedCore>;
  alive(pid: number): boolean;
  /** Снять зависшее на подъёме ядро (только своё, поднятое этим надзором). */
  kill(pid: number): void;
  /** Хвост журнала ядра, секреты уже замаскированы. */
  logTail(): string[];
  /**
   * Итог выхода, который ядро записало само (`core.exit.json`), — только для этого pid. Нужен,
   * когда ОС кода не отдала (Windows: ядро не ребёнок панели).
   */
  exitRecord?(pid: number): CoreExit | null;
  /** Ядро поднялось (своё или усыновлённое) — звенья P131 записываются здесь. */
  onUp?(pid: number, adopted: boolean): void;
  autostart(): CoreSupervisorStatus['autostart'];
  log(line: string): void;
  now(): number;
  timers?: CoreSupervisorTimers;
  /** Срок подъёма своего ядра до строки в `procs.json`, мс. */
  readyMs?: number;
  /** Опрос живости поднятого ядра, мс. */
  pollMs?: number;
}

export interface CoreSupervisor {
  /** `ensureCore`: усыновить живое ядро дома или поднять своё. */
  start(): void;
  status(): CoreSupervisorStatus;
  /** Кнопка «Перезапустить» карточки сбоя: счёт неудач с нуля, подъём сразу. */
  restart(): CoreSupervisorStatus;
  /** Ждать состояния `up` не дольше `ms`; `true` — дождались. */
  whenUp(ms: number): Promise<boolean>;
  /** Погасить надзор при выходе панели; само ядро живёт дальше. */
  stop(): void;
}
