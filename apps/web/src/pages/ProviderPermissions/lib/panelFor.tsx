import { useProviderPermissions } from '@entities/ProviderPermissions';
import type { SavePermissionsMutation } from '../ProviderPermissionsPanel.types';
import { OpencodePermissionsPanel } from '../OpencodePermissionsPanel/OpencodePermissionsPanel';
import { QwenPermissionsPanel } from '../QwenPermissionsPanel/QwenPermissionsPanel';
import { ContinuePermissionsPanel } from '../ContinuePermissionsPanel/ContinuePermissionsPanel';
import { GoosePermissionsPanel } from '../GoosePermissionsPanel/GoosePermissionsPanel';
import { KimiPermissionsPanel } from '../KimiPermissionsPanel/KimiPermissionsPanel';
import { CursorPermissionsPanel } from '../CursorPermissionsPanel/CursorPermissionsPanel';
import { GeminiPermissionsPanel } from '../GeminiPermissionsPanel/GeminiPermissionsPanel';
import { CodexPermissionsPanel } from '../CodexPermissionsPanel/CodexPermissionsPanel';

/** Выбор формы по модели прав, которую вернул сервер. */
export function panelFor(
  data: NonNullable<ReturnType<typeof useProviderPermissions>['data']>,
  save: SavePermissionsMutation,
) {
  if (data.kind === 'opencode') return <OpencodePermissionsPanel data={data} save={save} />;
  if (data.kind === 'qwen') return <QwenPermissionsPanel data={data} save={save} />;
  if (data.kind === 'continue') return <ContinuePermissionsPanel data={data} save={save} />;
  if (data.kind === 'goose') return <GoosePermissionsPanel data={data} save={save} />;
  if (data.kind === 'kimi') return <KimiPermissionsPanel data={data} save={save} />;
  if (data.kind === 'cursor') return <CursorPermissionsPanel data={data} save={save} />;
  return data.kind === 'gemini' ? (
    <GeminiPermissionsPanel data={data} save={save} />
  ) : (
    <CodexPermissionsPanel data={data} save={save} />
  );
}
