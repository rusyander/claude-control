import { SkeletonList } from '@shared/ui/skeleton';
import { useProviderPermissions, useSaveProviderPermissions } from '@entities/ProviderPermissions';
import { CodexPermissionsPanel } from './CodexPermissionsPanel';
import { GeminiPermissionsPanel } from './GeminiPermissionsPanel';

/**
 * Универсальный раздел прав/аппрувов активного провайдера.
 *
 * Моделей прав ДВЕ, и они не сводятся друг к другу, поэтому страница только
 * загружает данные и выбирает форму по `kind`, который вернул сервер:
 *  - `codex` — два скалярных ключа корня config.toml (политика аппрувов + песочница);
 *  - `gemini` — режим аппрувов `general.defaultApprovalMode` в settings.json плюс
 *    белый (`coreTools`) и чёрный (`excludeTools`) списки инструментов.
 *
 * Права Claude — отдельная богатая страница (allow/deny/ask), сюда не попадают.
 */
export function ProviderPermissionsPage() {
  const { data, isLoading } = useProviderPermissions();
  const save = useSaveProviderPermissions();

  if (isLoading || !data) {
    return <SkeletonList rows={4} />;
  }

  return data.kind === 'gemini' ? (
    <GeminiPermissionsPanel data={data} save={save} />
  ) : (
    <CodexPermissionsPanel data={data} save={save} />
  );
}
