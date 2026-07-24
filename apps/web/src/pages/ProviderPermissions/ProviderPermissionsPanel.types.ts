import type { CodexPermissionInfo, GeminiPermissionInfo } from '@claude-control/contracts';
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
