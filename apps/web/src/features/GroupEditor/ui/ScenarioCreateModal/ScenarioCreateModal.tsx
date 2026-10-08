import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupScope } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { useSaveGroup } from '@entities/Group';
import { useProjectRegistry } from '@entities/Project';
import type { ScenarioCreateModalProps } from './ScenarioCreateModal.types';
import { GLOBAL_VALUE } from './ScenarioCreateModal.constants';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * Создание сценария — группы, у которой порядок работы и есть вся работа
 * (`flow: 'scenario'`). Здесь только то, без чего группу не записать: имя,
 * необязательное «Когда» и где она живёт. Шаги человек собирает уже в окне
 * группы — туда страница и переводит сразу после создания.
 */
export function ScenarioCreateModal({ isOpen, onOpenChange, onCreated }: ScenarioCreateModalProps) {
  const { t } = useTranslation();
  // Отказ — одной строкой в окне с причиной сервера («имя занято»): общий тост
  // рядом с «не сохранилось» давал два сообщения, и нужное пряталось.
  const saveGroup = useSaveGroup({ silentError: true });
  const [failure, setFailure] = useState('');
  const { data: projects = [] } = useProjectRegistry();
  const [name, setName] = useState('');
  const [when, setWhen] = useState('');
  const [scopeValue, setScopeValue] = useState(GLOBAL_VALUE);
  const [isTouched, setIsTouched] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setWhen('');
    setScopeValue(GLOBAL_VALUE);
    setIsTouched(false);
    setFailure('');
  }, [isOpen]);

  const isNameEmpty = name.trim().length === 0;
  const scopeOptions = [
    { value: GLOBAL_VALUE, label: t('groupsPage.scenarioCreate.scopeGlobal') },
    ...projects.map((project) => ({
      value: project.path,
      label: t('groupsPage.scenarioCreate.scopeProject', { path: project.name }),
    })),
  ];

  const handleCreate = (): void => {
    setIsTouched(true);
    if (isNameEmpty || saveGroup.isPending) return;
    setFailure('');
    const scope: GroupScope =
      scopeValue === GLOBAL_VALUE
        ? { kind: 'global' }
        : { kind: 'project', path: scopeValue, provider: 'claude' };
    saveGroup.mutate(
      {
        draft: {
          name: name.trim(),
          description: '',
          color: 'accent',
          icon: 'folder',
          members: [],
          env: {},
          scope,
          flow: 'scenario',
          when: when.trim() || undefined,
          isEnabled: true,
        },
      },
      {
        onSuccess: (group) => {
          onOpenChange(false);
          onCreated(group);
        },
        onError: (error) => setFailure(toErrorMessage(error) || t('errors.saveFailed')),
      },
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('groupsPage.scenarioCreate.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>
            {t('groupsPage.scenarioCreate.cancel')}
          </Button>
          <Button variant="primary" onClick={handleCreate} isLoading={saveGroup.isPending}>
            {t('groupsPage.scenarioCreate.create')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          handleCreate();
        }}
      >
        <Stack gap="var(--spacing-md)">
          <Typography variant="body-sm" color="subtle">
            {t('groupsPage.scenarioCreate.description')}
          </Typography>
          <TextField
            label={t('groupsPage.scenarioCreate.name')}
            value={name}
            onChange={setName}
            placeholder={t('groupsPage.scenarioCreate.namePlaceholder')}
            error={
              isTouched && isNameEmpty ? t('groupsPage.scenarioCreate.nameRequired') : undefined
            }
            autoFocus
          />
          <TextField
            label={t('groupsPage.scenarioCreate.when')}
            value={when}
            onChange={setWhen}
            hint={t('groupsPage.scenarioCreate.whenHint')}
          />
          <SelectField
            label={t('groupsPage.scenarioCreate.scope')}
            value={scopeValue}
            onChange={setScopeValue}
            options={scopeOptions}
          />
          {failure && (
            <Typography variant="body-sm" color="danger" role="alert">
              {failure}
            </Typography>
          )}
          {/* Enter в поле имени создаёт сценарий: кнопка футера вне формы. */}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </Stack>
      </form>
    </Modal>
  );
}
