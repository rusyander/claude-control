import type { HopLanguage } from '@agentdeck/contracts/core/hops';
import type { Dialect, KeyRef } from '@agentdeck/contracts/core/routes';

/** Как ядро находит и запускает хост звеньев (`ensureHopHost`). */
export interface EnsureHopHostOptions {
  /** Дом ядра: хост один на дом, его строка — в `<home>/procs.json`. */
  home: string;
  /** Каталог данных панели — ключи `panel-store` и правила маски; нет — встроенные правила. */
  panelAppData?: string;
  stallMs?: number;
  flushMs?: number;
  retryPauseMs?: number;
  ownerBootId?: string;
  /** Язык отказов хоста до того, как сеанс известен; источник — см. `HopLanguage`. */
  language?: HopLanguage;
  /** Сколько ждать строки запущенного хоста (мс). */
  startTimeoutMs?: number;
  /** Windows: вырваться из задания ядра (WMI) — так хост переживает ядро под сторожем. */
  breakaway?: boolean;
}

/** Найденный живой хост: адрес управления и токен (токен — только в памяти ядра). */
export interface HopHostHandle {
  url: string;
  token: string;
  pid: number;
  dlpPort: number | null;
  gatewayPort: number | null;
  /** Хост запущен этим вызовом, а не найден живым. */
  launched: boolean;
}

/** Что `applyHopEnv` знает о сеансе: диалект клиента и ссылку ключа маршрута. */
export interface HopEnvSpec {
  from: Dialect;
  keyRef: KeyRef | null;
}
