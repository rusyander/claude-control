import type { EnvVar } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { SourceBadge } from '@shared/ui/source-badge';
import { Badge } from '@shared/ui/badge';
import { envFileName } from '@features/EnvEditor';

/**
 * Бейдж источника. Локальный файл — общим бейджем с его объяснением; переменная
 * включённой группы — именем группы: она лежит в settings.json, но её хозяин —
 * группа, и правится она там (удалённую здесь группа вернула бы при следующем
 * включении). Остальные — именем файла, а не словом из enum: человек ищет
 * глазами settings.json, не «settings».
 */
export function EnvSourceBadge({ item, groupName }: { item: EnvVar; groupName?: string }) {
  const { t } = useTranslation();
  if (item.source === 'settings-local') return <SourceBadge source="settings-local" />;
  if (item.source === 'group') {
    return (
      <Badge tone="accent">{t('env.groupBadge', { name: groupName ?? item.groupId ?? '' })}</Badge>
    );
  }
  return (
    <Badge tone={item.source === 'secrets' ? 'warning' : 'neutral'}>
      {envFileName(item.source)}
    </Badge>
  );
}
