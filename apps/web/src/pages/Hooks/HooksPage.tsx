import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { SourceBadge } from '@shared/ui/source-badge';
import { Toggle } from '@shared/ui/toggle';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { Button } from '@shared/ui/button';
import { HookFormModal } from '@features/HookEditor';
import { DeleteButton } from '@features/EntityDelete';
import { SandboxButton } from '@features/SandboxRunner';
import { hookApi, useMoveHook } from '@entities/Hook';
import type { Hook } from '@claude-control/contracts';
import styles from './HooksPage.module.scss';

/** Раздел хуков: что и на каком событии запускается. */
export function HooksPage() {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Hook | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const { data: hooks = [], isLoading } = hookApi.useList();
  const setEnabled = hookApi.useSetEnabled();
  const deleteHook = hookApi.useDelete();
  const moveHook = useMoveHook();

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };

  const openEdit = (hook: Hook): void => {
    setEditing(hook);
    setIsFormOpen(true);
    writeUrl(hook.id);
  };

  // Ссылка /hooks?id=<событие:группа:номер> открывает этот хук в редакторе.
  const writeUrl = useEntityUrlWriter();
  useEntityUrl<Hook>({ items: hooks, getId: (hook) => hook.id, onOpen: openEdit });

  const closeForm = (open: boolean): void => {
    setIsFormOpen(open);
    if (!open) writeUrl(undefined);
  };

  // Группируем по событию: так видно, что происходит в каждой точке жизненного цикла.
  const byEvent = hooks.reduce<Record<string, typeof hooks>>((acc, hook) => {
    (acc[hook.event] ??= []).push(hook);
    return acc;
  }, {});

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('hooks.title')}
        subtitle={t('hooks.subtitle')}
        helpTopic="hooks"
        actions={
          <Button variant="primary" leftIcon={<Icon name="plus" size={24} />} onClick={openCreate}>
            {t('hooks.addHook')}
          </Button>
        }
      />

      <ExplainBox title={t('hooks.explainTitle')} text={t('hooks.explain')} />

      {isLoading && <SkeletonList rows={5} />}

      {Object.entries(byEvent).map(([event, eventHooks]) => (
        <Stack key={event} gap="var(--spacing-xs)">
          <Typography variant="body-sm" weight="semibold" color="accent">
            {event}
          </Typography>

          {eventHooks.map((hook, index) => (
            <Card key={hook.id} padding="md">
              <Stack direction="row" gap="var(--spacing-md)" align="start" width="100%">
                <Stack gap="var(--spacing-2xs)" flex={1} minWidth={0}>
                  <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                    {hook.matcher && <Badge tone="accent">{hook.matcher}</Badge>}
                    {hook.scriptExists === false && (
                      <Badge tone="danger" withDot>
                        {t('hooks.scriptMissing')}
                      </Badge>
                    )}
                    <SourceBadge source={hook.source} />
                  </Stack>

                  {hook.description && (
                    <Typography
                      variant="body-sm"
                      color="muted"
                      clamp={2}
                      className={styles.description}
                    >
                      {hook.description}
                    </Typography>
                  )}

                  <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                    <Icon name="link" size={24} />
                    <Typography variant="mono" color="subtle" as="span" truncate>
                      {hook.command}
                    </Typography>
                  </Stack>
                </Stack>

                <Stack direction="row" align="center" gap="var(--spacing-xs)" flexShrink={0}>
                  {eventHooks.length > 1 && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon={<Icon name="chevronLeft" size={20} className={styles.moveUp} />}
                        aria-label={t('hooks.moveUp')}
                        disabled={index === 0 || moveHook.isPending}
                        onClick={() => moveHook.mutate({ id: hook.id, direction: 'up' })}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon={<Icon name="chevronLeft" size={20} className={styles.moveDown} />}
                        aria-label={t('hooks.moveDown')}
                        disabled={index === eventHooks.length - 1 || moveHook.isPending}
                        onClick={() => moveHook.mutate({ id: hook.id, direction: 'down' })}
                      />
                    </>
                  )}
                  <SandboxButton
                    kind="hook"
                    title={`${hook.event}${hook.matcher ? ` · ${hook.matcher}` : ''}`}
                    hookId={hook.id}
                    selection={{ hookIds: [hook.id] }}
                    context={{ event: hook.event, matcher: hook.matcher }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={<Icon name="edit" size={24} />}
                    aria-label={`${t('common.edit')}: ${hook.event}`}
                    onClick={() => openEdit(hook)}
                  />
                  <DeleteButton
                    entityName={`${hook.event}${hook.matcher ? ` · ${hook.matcher}` : ''}`}
                    description={
                      hook.source === 'settings-local'
                        ? t('common.deleteHookLocal')
                        : t('common.deleteHook')
                    }
                    onDelete={() => deleteHook.mutate(hook.id)}
                    isPending={deleteHook.isPending}
                  />
                  {/* Тумблер только у своих записей: выключение хука — это его
                      удаление из файла, а личный файл панель правит лишь тогда,
                      когда об этом попросили явно. */}
                  {hook.source !== 'settings-local' && (
                    <Toggle
                      checked={hook.isEnabled}
                      onCheckedChange={(isEnabled) => setEnabled.mutate({ id: hook.id, isEnabled })}
                      aria-label={`${hook.event} ${hook.matcher ?? ''}`}
                    />
                  )}
                </Stack>
              </Stack>
            </Card>
          ))}
        </Stack>
      ))}

      <HookFormModal isOpen={isFormOpen} onOpenChange={closeForm} hook={editing} />
    </Stack>
  );
}
