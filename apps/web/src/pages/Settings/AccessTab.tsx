import { Stack } from '@shared/ui/stack';
import { AccountCard } from './AccountCard';
import { ClaudeDirField } from './ClaudeDirField';
import { CredentialsCard } from './CredentialsCard';
import { RemoteAccessCard } from './RemoteAccessCard';

/**
 * Раздел «Доступ»: кем панель входит в Claude Code, откуда берёт доступ, какой
 * каталог конфигурации читает и кого пускает к себе снаружи. Удалённый доступ
 * стоит здесь же: обе стороны вопроса — про то, кому что открыто.
 */
export function AccessTab() {
  return (
    <Stack gap="var(--spacing-lg)">
      <AccountCard />
      <CredentialsCard />
      <ClaudeDirField />
      <RemoteAccessCard />
    </Stack>
  );
}
