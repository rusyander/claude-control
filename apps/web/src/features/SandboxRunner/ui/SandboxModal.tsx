import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import {
  useCreateSandbox,
  useDeleteSandbox,
  type SandboxDescription,
} from '@entities/Sandbox/api/SandboxApi';
import { HookProbePanel } from './HookProbePanel';
import { McpProbePanel } from './McpProbePanel';
import { SandboxChat } from './SandboxChat';
import type { SandboxModalProps } from './SandboxModal.types';
import styles from './SandboxModal.module.scss';

type Tab = 'probe' | 'chat';

/**
 * Песочница: проверка настройки в изоляции.
 *
 * Способов проверки два, и они дополняют друг друга. Прямой прогон отвечает
 * на вопрос «срабатывает ли механика» — мгновенно и без обращения к модели.
 * Разговор отвечает на вопрос «меняет ли это поведение Claude» — так
 * проверяются правила и скиллы, у которых нет иной наблюдаемой стороны.
 */
export function SandboxModal({
  isOpen,
  onOpenChange,
  kind,
  title,
  selection,
  mcpId,
  scriptName,
  hookId,
  context,
}: SandboxModalProps) {
  const { t } = useTranslation();

  // Прямой прогон есть только у того, что можно запустить самому.
  const hasProbe = kind === 'hook' || kind === 'script' || kind === 'mcp';
  const [tab, setTab] = useState<Tab>(hasProbe ? 'probe' : 'chat');
  const [description, setDescription] = useState<SandboxDescription | undefined>(undefined);

  const sandboxId = useMemo(() => `ui-${kind}-${Date.now()}`, [kind, isOpen]);

  const create = useCreateSandbox();
  const remove = useDeleteSandbox();

  useEffect(() => {
    if (!isOpen) return;

    setTab(hasProbe ? 'probe' : 'chat');
    create.mutate(
      { id: sandboxId, selection },
      { onSuccess: (data) => setDescription(data.description) },
    );

    // Песочница живёт ровно столько, сколько открыто окно: закрыли — стёрли.
    return () => {
      remove.mutate(sandboxId);
      setDescription(undefined);
    };
  }, [isOpen, sandboxId]);

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={`${t('sandbox.title')}: ${title}`}
      description={t('sandbox.subtitle')}
      size="xl"
      footer={<Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>}
    >
      <div className={styles.layout}>
        <div className={styles.main}>
          {hasProbe && (
            <div className={styles.tabs}>
              <TabButton isActive={tab === 'probe'} onClick={() => setTab('probe')}>
                {kind === 'mcp' ? t('sandbox.tabTools') : t('sandbox.tabProbe')}
              </TabButton>
              <TabButton isActive={tab === 'chat'} onClick={() => setTab('chat')}>
                {t('sandbox.tabChat')}
              </TabButton>
            </div>
          )}

          {tab === 'probe' && kind === 'mcp' && mcpId && <McpProbePanel mcpId={mcpId} />}

          {tab === 'probe' && kind !== 'mcp' && (
            <HookProbePanel sandboxId={sandboxId} hookId={hookId} scriptName={scriptName} />
          )}

          {tab === 'chat' && (
            <SandboxChat sandboxId={sandboxId} kind={kind} title={title} context={context} />
          )}
        </div>

        <aside className={styles.aside}>
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body-sm" weight="medium">
              {t('sandbox.contents')}
            </Typography>

            {create.isPending && <Typography color="muted">{t('sandbox.preparing')}</Typography>}

            {description && <ContentsList description={description} />}

            <div className={styles.isolation}>
              <Stack gap="var(--spacing-3xs)">
                <Stack direction="row" align="center" gap="var(--spacing-3xs)">
                  <Icon name="permissions" size={20} />
                  <Typography variant="body-sm" weight="medium" as="span">
                    {t('sandbox.isolationTitle')}
                  </Typography>
                </Stack>
                <Typography variant="caption" color="subtle">
                  {t('sandbox.isolationText')}
                </Typography>
              </Stack>
            </div>
          </Stack>
        </aside>
      </div>
    </Modal>
  );
}

function ContentsList({ description }: { description: SandboxDescription }) {
  const { t } = useTranslation();

  const groups: [string, string[]][] = [
    [t('nav.rules'), description.rules],
    [t('nav.skills'), description.skills],
    [t('nav.hooks'), description.hooks],
    [t('nav.scripts'), description.scripts],
    [t('nav.mcp'), description.mcpServers],
  ];

  const filled = groups.filter(([, items]) => items.length > 0);

  if (filled.length === 0) {
    return (
      <Typography variant="caption" color="subtle">
        {t('sandbox.empty')}
      </Typography>
    );
  }

  return (
    <Stack gap="var(--spacing-2xs)">
      {filled.map(([label, items]) => (
        <Stack key={label} gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle" as="span">
            {label}
          </Typography>
          <Stack direction="row" gap="var(--spacing-3xs)" wrap>
            {items.map((item) => (
              <Badge key={item} tone="info">
                {item}
              </Badge>
            ))}
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}

function TabButton({
  isActive,
  onClick,
  children,
}: {
  isActive: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
