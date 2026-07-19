import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Automation, EntityRef, Group } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { Toggle } from '@shared/ui/toggle';
import { GroupFormModal } from '@features/GroupEditor';
import { AutomationFormModal } from '@features/AutomationEditor';
import { SandboxButton } from '@features/SandboxRunner';
import { DeleteButton } from '@features/EntityDelete';
import {
  useGroups,
  useAutomations,
  useSetGroupEnabled,
  useDeleteGroup,
  useSaveAutomation,
  useDeleteAutomation,
} from '@entities/Group';
import type { SandboxSelection } from '@entities/Sandbox/api/SandboxApi';
import styles from './GroupsPage.module.scss';

/**
 * Состав группы для песочницы. Права в изолированный прогон не переносим:
 * там свои границы, и чужие разрешения их только запутали бы.
 */
function selectionOfGroup(members: EntityRef[]): SandboxSelection {
  return {
    ruleIds: members.filter((item) => item.kind === 'rule').map((item) => item.id),
    skillIds: members.filter((item) => item.kind === 'skill').map((item) => item.id),
    hookIds: members.filter((item) => item.kind === 'hook').map((item) => item.id),
    mcpIds: members.filter((item) => item.kind === 'mcp').map((item) => item.id),
  };
}

/** Группы и сценарии: пользовательская структура поверх сущностей Claude Code. */
export function GroupsPage() {
  const { t } = useTranslation();
  const [editingGroup, setEditingGroup] = useState<Group | undefined>(undefined);
  const [isGroupFormOpen, setIsGroupFormOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<Automation | undefined>(undefined);
  const [isAutomationFormOpen, setIsAutomationFormOpen] = useState(false);

  const { data: groups = [], isLoading } = useGroups();
  const { data: automations = [] } = useAutomations();
  const setGroupEnabled = useSetGroupEnabled();
  const deleteGroup = useDeleteGroup();
  const saveAutomation = useSaveAutomation();
  const deleteAutomation = useDeleteAutomation();

  const openCreateGroup = (): void => {
    setEditingGroup(undefined);
    setIsGroupFormOpen(true);
  };

  const openEditGroup = (group: Group): void => {
    setEditingGroup(group);
    setIsGroupFormOpen(true);
    writeUrl(group.id);
  };

  // Ссылка /groups?id=<uuid> открывает эту группу в редакторе.
  const writeUrl = useEntityUrlWriter();
  useEntityUrl<Group>({ items: groups, getId: (group) => group.id, onOpen: openEditGroup });

  const closeGroupForm = (open: boolean): void => {
    setIsGroupFormOpen(open);
    if (!open) writeUrl(undefined);
  };

  const openCreateAutomation = (): void => {
    setEditingAutomation(undefined);
    setIsAutomationFormOpen(true);
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('groups.title')}
        subtitle={t('groups.subtitle')}
        helpTopic="groups"
        actions={
          <Button
            variant="primary"
            leftIcon={<Icon name="plus" size={24} />}
            onClick={openCreateGroup}
          >
            {t('groups.addGroup')}
          </Button>
        }
      />

      <ExplainBox title={t('groups.explainTitle')} text={t('groups.explain')} />

      {isLoading && <SkeletonList rows={5} />}

      <Stack gap="var(--spacing-sm)">
        {groups.map((group) => (
          <Card key={group.id} padding="md">
            <Stack
              direction="row"
              align="start"
              justify="between"
              gap="var(--spacing-md)"
              width="100%"
            >
              <Stack gap="var(--spacing-2xs)">
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Typography variant="body" weight="medium" as="span">
                    {group.name}
                  </Typography>
                  <Badge tone="accent">
                    {group.members.length} {t('groups.members')}
                  </Badge>
                  {Object.keys(group.env ?? {}).length > 0 && (
                    <Badge tone="info">env: {Object.keys(group.env ?? {}).length}</Badge>
                  )}
                  {!group.isEnabled && <Badge tone="neutral">{t('common.disabled')}</Badge>}
                </Stack>
                {group.description && (
                  <Typography variant="body-sm" color="muted">
                    {group.description}
                  </Typography>
                )}
              </Stack>

              <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                <SandboxButton
                  kind="group"
                  title={group.name}
                  selection={selectionOfGroup(group.members)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<Icon name="edit" size={24} />}
                  aria-label={`${t('common.edit')}: ${group.name}`}
                  onClick={() => openEditGroup(group)}
                />
                <DeleteButton
                  entityName={group.name}
                  description={t('common.deleteGroup')}
                  onDelete={() => deleteGroup.mutate(group.id)}
                  isPending={deleteGroup.isPending}
                />
                <Toggle
                  checked={group.isEnabled}
                  onCheckedChange={(isEnabled) =>
                    setGroupEnabled.mutate({ id: group.id, isEnabled })
                  }
                  disabled={setGroupEnabled.isPending}
                  aria-label={`${t('common.enabled')}: ${group.name}`}
                />
              </Stack>
            </Stack>
          </Card>
        ))}
      </Stack>

      {!isLoading && groups.length === 0 && (
        <EmptyState
          icon="groups"
          title={t('groups.emptyTitle')}
          text={t('groups.emptyText')}
          action={
            <Button
              variant="primary"
              leftIcon={<Icon name="plus" size={20} />}
              onClick={openCreateGroup}
            >
              {t('groups.addGroup')}
            </Button>
          }
        />
      )}

      <Stack gap="var(--spacing-sm)" marginTop="var(--spacing-lg)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-md)" wrap>
          <Typography variant="heading-sm">{t('groups.automations')}</Typography>
          <Button leftIcon={<Icon name="plus" size={24} />} onClick={openCreateAutomation}>
            {t('groups.addAutomation')}
          </Button>
        </Stack>

        <ExplainBox title={t('groups.automations')} text={t('groups.automationsExplain')} />

        {automations.map((automation) => (
          <Card key={automation.id} padding="md">
            <Stack
              direction="row"
              align="start"
              justify="between"
              gap="var(--spacing-md)"
              width="100%"
            >
              <Stack gap="var(--spacing-2xs)">
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Typography variant="body" weight="medium" as="span">
                    {automation.name}
                  </Typography>
                  {!automation.isEnabled && <Badge tone="neutral">{t('common.disabled')}</Badge>}
                </Stack>
                <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                  <Badge tone="accent">{automation.trigger.event}</Badge>
                  {automation.trigger.matcher && (
                    <Badge tone="neutral">{automation.trigger.matcher}</Badge>
                  )}
                  <Icon name="chevronRight" size={24} />
                  <Typography variant="mono" color="subtle" as="span" truncate>
                    {automation.action.command}
                  </Typography>
                </Stack>
              </Stack>

              <Stack direction="row" align="center" gap="var(--spacing-2xs)" flexShrink={0}>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<Icon name="edit" size={24} />}
                  aria-label={`${t('common.edit')}: ${automation.name}`}
                  onClick={() => {
                    setEditingAutomation(automation);
                    setIsAutomationFormOpen(true);
                  }}
                />
                <DeleteButton
                  entityName={automation.name}
                  description={t('common.deleteAutomation')}
                  onDelete={() => deleteAutomation.mutate(automation.id)}
                  isPending={deleteAutomation.isPending}
                />
                {/* Выключенный сценарий не компилируется в хук — сервер это уже
                    умел, не хватало только переключателя. */}
                <Toggle
                  checked={automation.isEnabled}
                  onCheckedChange={(isEnabled) =>
                    saveAutomation.mutate({
                      id: automation.id,
                      automation: { ...automation, isEnabled },
                    })
                  }
                  disabled={saveAutomation.isPending}
                  aria-label={`${t('common.enabled')}: ${automation.name}`}
                />
              </Stack>
            </Stack>
          </Card>
        ))}

        {automations.length === 0 && <Typography color="subtle">{t('common.empty')}</Typography>}
      </Stack>

      <GroupFormModal isOpen={isGroupFormOpen} onOpenChange={closeGroupForm} group={editingGroup} />
      <AutomationFormModal
        isOpen={isAutomationFormOpen}
        onOpenChange={setIsAutomationFormOpen}
        automation={editingAutomation}
      />
    </Stack>
  );
}
