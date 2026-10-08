import { SkeletonList } from '@shared/ui/skeleton';
import { useProviderPermissions, useSaveProviderPermissions } from '@entities/ProviderPermissions';
import { useWritePreview } from '@features/WritePreview';
import type { SavePermissionsMutation } from '../ProviderPermissionsPanel.types';
import { panelFor } from '../lib/panelFor';

/**
 * Универсальный раздел прав/аппрувов активного провайдера.
 *
 * Моделей прав ВОСЕМЬ, и они не сводятся друг к другу, поэтому страница только
 * загружает данные и выбирает форму по `kind`, который вернул сервер:
 *  - `codex` — два скалярных ключа корня config.toml (политика аппрувов + песочница);
 *  - `gemini` — режим аппрувов `general.defaultApprovalMode` в settings.json плюс
 *    белый (`coreTools`) и чёрный (`excludeTools`) списки инструментов;
 *  - `qwen` — `tools.approvalMode` в settings.json плюс три списка правил
 *    `permissions.allow` / `ask` / `deny` (форк Gemini, но ключи прав другие);
 *  - `continue` — три списка `allow` / `ask` / `exclude` в отдельном файле
 *    `permissions.yaml`; режима-переключателя у Continue нет вовсе;
 *  - `goose` — один скалярный ключ `GOOSE_MODE` в config.yaml (`auto` /
 *    `approve` / `smart_approve` / `chat`); списков правил у Goose нет вовсе;
 *  - `kimi` — `default_permission_mode` в config.toml (`manual` / `auto` / `yolo`)
 *    плюс УПОРЯДОЧЕННЫЙ массив правил `[[permission.rules]]` (решение + шаблон);
 *  - `opencode` — ключ `permission` в opencode.json: уровень `allow`/`deny`/`ask`
 *    у инструмента, у `bash` — ещё и список шаблонов команд;
 *  - `cursor` — два списка `permissions.allow` / `permissions.deny` в
 *    `cli-config.json`; ни режима, ни списка `ask` у Cursor нет, `deny` сильнее.
 *
 * Предпросмотр записи подставляется ЗДЕСЬ, а не в каждой панели: панели получают
 * мутацию сохранения от страницы, поэтому обёртка в одном месте закрывает все
 * восемь форм сразу и ни одна не может о ней «забыть».
 *
 * Права Claude — отдельная богатая страница (allow/deny/ask), сюда не попадают.
 */
export function ProviderPermissionsPage() {
  const { data, isLoading } = useProviderPermissions();
  const saveMutation = useSaveProviderPermissions();
  const { ask, dialog } = useWritePreview();

  const save: SavePermissionsMutation = {
    ...saveMutation,
    mutate: (draft, options) =>
      ask({ section: 'permissions', draft }, () => saveMutation.mutate(draft, options)),
  };

  if (isLoading || !data) {
    return <SkeletonList rows={4} />;
  }

  return (
    <>
      {panelFor(data, save)}
      {dialog}
    </>
  );
}
