/**
 * Локальный слой проекта (`.agent/local-layer/`): командный слой, собранный
 * копией и подключённый к чатам панели вместо самого командного. Сервер —
 * `apps/server/src/domains/local-layer/`, справка — тема «Чат».
 */

export type LocalLayerMode = 'auto' | 'on' | 'off';

export const LOCAL_LAYER_MODES: readonly LocalLayerMode[] = ['auto', 'on', 'off'];

export type OverrideState = 'active' | 'retired' | 'stale' | 'unrelocatable' | 'missing-ref';

export interface OverrideStatus {
  ref: string;
  entries: string[];
  why?: string;
  state: OverrideState;
  /** Файлы замыкания, которые замена действительно меняет. */
  improved: string[];
  /** Почему замена не действует (stale / unrelocatable / missing-ref). */
  detail?: string;
}

/**
 * Почему слой подключён или нет: `no-config` — у проекта нет `layer.json`;
 * `off` — выключен; `on` — включён всегда; `gain` / `no-gain` — режим «авто»
 * и есть ли выгода; `broken` — сборка не удалась, чат идёт на командном слое.
 */
export type LayerReason = 'off' | 'no-config' | 'on' | 'gain' | 'no-gain' | 'broken';

export interface LocalLayerStatus {
  root: string;
  mode: LocalLayerMode;
  /** Есть ли `layer.json`: без него слой не собирается вовсе. */
  configured: boolean;
  used: boolean;
  reason: LayerReason;
  builtAt?: string;
  /** Отказ сборки — текст для человека; слой при нём не используется. */
  error?: string;
  instructions: {
    files: number;
    teamChars: number;
    layerChars: number;
    sections: number;
    compressed: number;
    /** Сжатые куски, чей командный оригинал изменился: едут дословно, ждут нового сжатия. */
    pending: string[];
  };
  pathRules: number;
  skills: string[];
  agents: number;
  commands: number;
  mcpServers: string[];
  hooks: number;
  overrides: OverrideStatus[];
  /** Сжатые файлы без командного оригинала — не используются. */
  orphans: string[];
  excluded: number;
}
