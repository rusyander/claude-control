import { SkeletonList } from '@shared/ui/skeleton';
import { useProviderPermissions, useSaveProviderPermissions } from '@entities/ProviderPermissions';
import { CodexPermissionsPanel } from './CodexPermissionsPanel';
import { GeminiPermissionsPanel } from './GeminiPermissionsPanel';
import { OpencodePermissionsPanel } from './OpencodePermissionsPanel';

/**
 * Универсальный раздел прав/аппрувов активного провайдера.
 *
 * Моделей прав ТРИ, и они не сводятся друг к другу, поэтому страница только
 * загружает данные и выбирает форму по `kind`, который вернул сервер:
 *  - `codex` — два скалярных ключа корня config.toml (политика аппрувов + песочница);
 *  - `gemini` — режим аппрувов `general.defaultApprovalMode` в settings.json плюс
 *    белый (`coreTools`) и чёрный (`excludeTools`) списки инструментов;
 *  - `opencode` — ключ `permission` в opencode.json: уровень `allow`/`deny`/`ask`
 *    у инструмента, у `bash` — ещё и список шаблонов команд.
 *
 * Права Claude — отдельная богатая страница (allow/deny/ask), сюда не попадают.
 */
export function ProviderPermissionsPage() {
  const { data, isLoading } = useProviderPermissions();
  const save = useSaveProviderPermissions();

  if (isLoading || !data) {
    return <SkeletonList rows={4} />;
  }

  if (data.kind === 'opencode') return <OpencodePermissionsPanel data={data} save={save} />;
  return data.kind === 'gemini' ? (
    <GeminiPermissionsPanel data={data} save={save} />
  ) : (
    <CodexPermissionsPanel data={data} save={save} />
  );
}
