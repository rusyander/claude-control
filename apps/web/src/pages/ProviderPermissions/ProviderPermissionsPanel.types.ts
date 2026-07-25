import type {
  CodexPermissionInfo,
  ContinuePermissionInfo,
  CursorPermissionInfo,
  GeminiPermissionInfo,
  GoosePermissionInfo,
  KimiPermissionInfo,
  OpencodePermissionInfo,
  QwenPermissionInfo,
} from '@claude-control/contracts';
import type { useSaveProviderPermissions } from '@entities/ProviderPermissions';

/** Мутация сохранения прав — одна на обе модели, форму черновика задаёт панель. */
export type SavePermissionsMutation = ReturnType<typeof useSaveProviderPermissions>;

/** Панель прав Codex: два скалярных ключа корня config.toml. */
export interface CodexPermissionsPanelProps {
  data: CodexPermissionInfo;
  save: SavePermissionsMutation;
}

/** Панель прав Gemini: режим аппрувов + белый и чёрный списки инструментов. */
export interface GeminiPermissionsPanelProps {
  data: GeminiPermissionInfo;
  save: SavePermissionsMutation;
}

/** Панель прав Qwen Code: режим аппрувов + три списка правил `permissions.*`. */
export interface QwenPermissionsPanelProps {
  data: QwenPermissionInfo;
  save: SavePermissionsMutation;
}

/** Панель прав Continue: три списка `permissions.yaml`, режима нет. */
export interface ContinuePermissionsPanelProps {
  data: ContinuePermissionInfo;
  save: SavePermissionsMutation;
}

/** Панель прав Cursor: два списка `permissions.allow`/`deny`, режима нет. */
export interface CursorPermissionsPanelProps {
  data: CursorPermissionInfo;
  save: SavePermissionsMutation;
}

/** Панель прав Goose: один режим `GOOSE_MODE` в config.yaml, списков нет. */
export interface GoosePermissionsPanelProps {
  data: GoosePermissionInfo;
  save: SavePermissionsMutation;
}

/** Панель прав Kimi Code: режим `default_permission_mode` + правила `[[permission.rules]]`. */
export interface KimiPermissionsPanelProps {
  data: KimiPermissionInfo;
  save: SavePermissionsMutation;
}

/** Панель прав OpenCode: ключ `permission` в opencode.json (уровни + шаблоны bash). */
export interface OpencodePermissionsPanelProps {
  data: OpencodePermissionInfo;
  save: SavePermissionsMutation;
}
