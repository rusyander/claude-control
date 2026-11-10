import type { ProjectRunnerView } from '@agentdeck/contracts';
import type { PickPayload, SitePreview } from '@agentdeck/contracts/site-preview';

/**
 * Что окну сайта нужно от реестра запусков. Узкий порт вместо самого реестра: окно открывает
 * только то, что панель запустила сама, и закрывается вместе с записью запуска (P173).
 */
export interface SiteRunnerSource {
  /** Запись цели по её пути (ключ реестра), undefined — цель не запускалась. */
  get(target: { projectPath: string }): ProjectRunnerView | undefined;
  /** Запись цели ушла (остановлена, упала, панель выходит); вернуть — отписка. */
  onGone(listener: (path: string) => void): () => void;
}

/** Куда прокси шлёт запросы: только loopback-адрес, который назвал реестр. */
export interface SiteProxyTarget {
  host: string;
  port: number;
}

export interface SiteProxyOptions {
  target: SiteProxyTarget;
  /** `nonce` окна — его знает скрипт выбора и проверяет родитель. */
  nonce: string;
}

/** Живой прокси одного сайта: свой порт на 127.0.0.1. */
export interface SiteProxy {
  port: number;
  /** Адрес, на котором слушает сокет, — `127.0.0.1`, никогда не все интерфейсы. */
  address: string;
  /** `http://127.0.0.1:<port>` — origin окна сайта в панели. */
  origin: string;
  close(): Promise<void>;
}

/** Открытое окно сайта: прокси, его `nonce` и адрес сайта, который за ним стоит. */
export interface OpenSite {
  siteId: string;
  /** Путь цели в реестре — по нему окно закрывается вместе с запуском. */
  path: string;
  nonce: string;
  /** Origin dev-сервера (`http://localhost:5173`) — в него переписывается адрес выбора. */
  devOrigin: string;
  targetPort: number;
  proxy: SiteProxy;
}

/** Отказ окна: код уходит клиенту, текст отказа клиент берёт из своего словаря. */
export type SitePreviewRefusal =
  'site-not-running' | 'site-not-loopback' | 'site-unknown' | 'pick-nonce';

export type SiteOpenResult =
  { ok: true; preview: SitePreview } | { ok: false; code: SitePreviewRefusal };

export type SitePickResult =
  { ok: true; pick: PickPayload } | { ok: false; code: SitePreviewRefusal };
