/** Цель проекта конфига Playwright: его `testDir` (нет — общий адрес) и адрес стенда. */
export interface RunnerTarget {
  testDir?: string;
  /** Нет — переменная не задана, а адреса по умолчанию в конфиге нет. */
  url?: string;
  /** Откуда адрес: имя переменной или «по умолчанию конфига». */
  from: string;
}

export interface StandTargets {
  config: string | undefined;
  urls: { url: string; from: string }[];
  /** Цели без адреса: переменная не задана, а по умолчанию в конфиге ничего. */
  unresolved: string[];
  /** Стенд поднимает сам Playwright (`webServer`) — до прогона его нет. */
  webServer?: boolean;
}
