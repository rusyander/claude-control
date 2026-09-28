import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupDraft, GroupMember } from '@agentdeck/contracts';
import { toErrorMessage } from '@shared/api/client';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { useSaveGroup } from '@entities/Group';
import { permissionApi } from '@entities/Permission';
import { useProjectRegistry } from '@entities/Project';
import { envToText, textToEnv } from '@shared/lib/env-text';
import { groupAssistantSpec, memberRef, membersFromRefs } from '../model/groupAssistant';
import { useMemberCatalog } from '../model/useMemberCatalog';
import { MemberPicker } from './MemberPicker';
import { ProjectBinding } from './ProjectBinding';
import type { GroupFormModalProps } from './GroupFormModal.types';

/**
 * Создание и правка группы. Кроме состава у группы есть свои переменные
 * окружения: это позволяет держать наборы настроек и переключать их целиком,
 * не переписывая settings.json руками.
 */
export function GroupFormModal({ isOpen, onOpenChange, group }: GroupFormModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [envText, setEnvText] = useState('');
  const [projectPaths, setProjectPaths] = useState<string[]>([]);
  const [when, setWhen] = useState('');

  // Отказ — одной строкой в окне с причиной сервера: общий тост рядом с
  // «не сохранилось» давал два сообщения, и нужное пряталось.
  const saveGroup = useSaveGroup({ silentError: true });
  const [failure, setFailure] = useState('');
  const { data: permissions = [] } = permissionApi.useList();
  // Помощник выбирает участников и проекты из того же, что видит человек.
  const { items: catalog } = useMemberCatalog(group?.id);
  const { data: projects = [] } = useProjectRegistry();

  // Конфликт внутри группы: два участника-права с одним шаблоном, но разными
  // решениями (allow и deny разом). Claude Code возьмёт какое-то одно, а группа
  // — именно то место, где такое легко собрать по недосмотру.
  const conflicts = useMemo(() => {
    const decisionsByPattern = new Map<string, Set<string>>();
    for (const member of members) {
      if (member.kind !== 'permission') continue;
      const rule = permissions.find((item) => item.id === member.id);
      if (!rule) continue;
      const set = decisionsByPattern.get(rule.pattern) ?? new Set<string>();
      set.add(rule.decision);
      decisionsByPattern.set(rule.pattern, set);
    }
    return [...decisionsByPattern.entries()]
      .filter(([, decisions]) => decisions.size > 1)
      .map(([pattern]) => pattern);
  }, [members, permissions]);

  useEffect(() => {
    if (!isOpen) return;
    setName(group?.name ?? '');
    setDescription(group?.description ?? '');
    setMembers(group?.members ?? []);
    setEnvText(group ? envToText(group.env) : '');
    setProjectPaths(group?.projectPaths ?? []);
    setWhen(group?.when ?? group?.scenario?.when ?? '');
    setFailure('');
  }, [isOpen, group]);

  const canSave = name.trim().length > 0 && !saveGroup.isPending;

  const handleSave = (): void => {
    setFailure('');
    const draft: GroupDraft = {
      name: name.trim(),
      description: description.trim(),
      color: group?.color ?? 'accent',
      icon: group?.icon ?? 'folder',
      members,
      env: textToEnv(envText),
      projectPaths,
      // Порядок работы переехал во вкладку «Путь»; старый сценарий форма больше
      // не правит, но и не теряет — его переносит сервер, а не сохранение формы.
      scenario: group?.scenario,
      // Область не правится формой: без неё проектная группа при сохранении
      // молча стала бы глобальной.
      scope: group?.scope,
      // Строкой, а не `|| undefined`: сервер отличает «поля не прислали»
      // (прежнее «Когда» остаётся) от «прислали пустое» (стёрли). С
      // `undefined` ключ выпадал из JSON, и очистка молча не работала.
      when: when.trim(),
      isEnabled: group?.isEnabled ?? true,
    };
    saveGroup.mutate(
      { id: group?.id, draft },
      {
        onSuccess: () => onOpenChange(false),
        onError: (error) => setFailure(toErrorMessage(error) || t('errors.saveFailed')),
      },
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={group ? `${t('common.edit')}: ${group.name}` : t('groupsPage.create.bundleTitle')}
      size="xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!canSave}
            isLoading={saveGroup.isPending}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <FormWithAssistant
        kind="group"
        fields={{
          name,
          description,
          when,
          envText,
          members: members.map(memberRef),
          projectPaths,
        }}
        spec={groupAssistantSpec({ catalog, members, projects, projectPaths })}
        onApply={(applied) => {
          if (applied.name !== undefined) setName(applied.name);
          if (applied.description !== undefined) setDescription(applied.description);
          if (applied.when !== undefined) setWhen(applied.when);
          if (applied.envText !== undefined) setEnvText(applied.envText);
          if (applied.members) setMembers(membersFromRefs(applied.members, members, group?.scope));
          if (applied.projectPaths) setProjectPaths(applied.projectPaths);
        }}
      >
        <Stack gap="var(--spacing-md)">
          <TextField
            label={t('groups.groupName')}
            value={name}
            onChange={setName}
            placeholder={t('groups.groupNamePlaceholder')}
            autoFocus={!group}
          />

          <TextField
            label={t('groups.groupDescription')}
            value={description}
            onChange={setDescription}
            multiline
            rows={2}
          />

          <TextField
            label={t('groups.groupWhen')}
            value={when}
            onChange={setWhen}
            placeholder={t('groups.groupWhenPlaceholder')}
            hint={t('groups.groupWhenHint')}
          />

          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('groups.membersTitle')}
            </Typography>
            {/* Как у выбора шага (F-100): новый участник выключенной группы
                выключается не в группе, а везде (`reconcileMembers` на сервере) —
                человек узнаёт это до того, как отметит. */}
            {group && !group.isEnabled && (
              <Typography variant="body-sm" color="warning" data-group-off-warning>
                {t('groups.membersGroupOff')}
              </Typography>
            )}
            <MemberPicker
              value={members}
              onChange={setMembers}
              excludeGroupId={group?.id}
              groupScope={group?.scope}
            />
            {conflicts.length > 0 && (
              <Typography variant="caption" color="warning" as="span">
                {t('groups.conflict', { patterns: conflicts.join(', ') })}
              </Typography>
            )}
          </Stack>

          <Stack gap="var(--spacing-2xs)">
            <Typography variant="body-sm" weight="medium">
              {t('groups.projectsTitle')}
            </Typography>
            <ProjectBinding value={projectPaths} onChange={setProjectPaths} />
          </Stack>

          <TextField
            label={t('groups.groupEnv')}
            value={envText}
            onChange={setEnvText}
            multiline
            rows={4}
            placeholder="KEY=VALUE"
            hint={t('groups.groupEnvHint')}
            isMono
          />

          {failure && (
            <Typography variant="body-sm" color="danger" role="alert">
              {failure}
            </Typography>
          )}
        </Stack>
      </FormWithAssistant>
    </Modal>
  );
}
