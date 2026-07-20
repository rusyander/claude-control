import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { ResourceFileTree } from '@features/ResourceFiles';
import { useResourceTemplates, useApplyTemplate } from '@entities/Resource';
import { skillApi } from '@entities/Skill';
import type { SkillFormModalProps } from './SkillFormModal.types';
import styles from './SkillFormModal.module.scss';

/** Идентификатор скилла — имя папки; сервер строит его тем же правилом. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Конструктор скилла.
 *
 * Скилл бывает и одним SKILL.md, и папкой с модулями по темам, поэтому вверху —
 * явный выбор: простой скилл или конструктор со структурой файлов. В режиме
 * конструктора можно выбрать заготовку структуры ещё до создания, а после —
 * собрать дерево шаблоном, помощником или руками, не выходя из окна.
 */
export function SkillFormModal({ isOpen, onOpenChange, skill }: SkillFormModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  // Идентификатор скилла, с которым сейчас работаем: либо переданный на правку,
  // либо выданный после создания. Появился — показываем дерево структуры.
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  // Простой скилл или конструктор со структурой. У скилла с файлами конструктор
  // включаем сразу, чтобы дерево было на виду.
  const [isBuilder, setIsBuilder] = useState(false);
  // Заготовка структуры, выбранная до создания: применяется сразу после него.
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);

  const create = skillApi.useCreate();
  const update = skillApi.useUpdate();
  const templates = useResourceTemplates('skill');
  const applyTemplate = useApplyTemplate('skill', activeId ?? '');

  useEffect(() => {
    if (!isOpen) return;
    setName(skill?.name ?? '');
    setDescription(skill?.description ?? '');
    setBody(skill?.body ?? '');
    setActiveId(skill?.id);
    // У скилла с вложенными файлами конструктор открываем сразу.
    setIsBuilder(Boolean(skill && skill.files.length > 0));
    setTemplateId(undefined);
  }, [isOpen, skill]);

  const isPending = create.isPending || update.isPending;
  const canSave = name.trim().length > 0 && description.trim().length > 0 && !isPending;

  const handleSave = (): void => {
    const draft = { name: name.trim(), description: description.trim(), body, groupIds: [] };

    if (activeId) {
      update.mutate({ id: activeId, draft }, { onSuccess: () => onOpenChange(false) });
      return;
    }

    // После создания окно не закрываем: раскрываем дерево, чтобы собрать
    // структуру. Идентификатор совпадает со slug имени.
    create.mutate(draft, { onSuccess: () => setActiveId(slugify(draft.name)) });
  };

  // Выбранную до создания заготовку разворачиваем, когда скилл уже на диске:
  // применять её в onSuccess нельзя — мутация ещё замкнута на пустой id,
  // а верный появляется только со следующим рендером.
  useEffect(() => {
    if (!activeId || skill || !templateId) return;

    applyTemplate.mutate(templateId);
    // Разворачиваем один раз: сбрасываем выбор, чтобы эффект не повторился.
    setTemplateId(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Кнопка объясняет, что произойдёт: у конструктора первый шаг — создать скилл,
  // а дерево появится после.
  const primaryLabel = activeId
    ? skill
      ? t('common.save')
      : t('skills.saveFrontmatter')
    : isBuilder
      ? t('skills.createAndBuild')
      : t('common.save');

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={skill ? `${t('common.edit')}: ${skill.name}` : t('skills.addSkill')}
      description={t('common.needsRestart')}
      size="xl"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>
            {activeId ? t('common.close') : t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave} isLoading={isPending}>
            {primaryLabel}
          </Button>
        </>
      }
    >
      {/* Явный выбор режима — как в правах и переменных. Пока скилл не создан:
          после создания режим уже определён его содержимым. */}
      {!activeId && (
        <div className={styles.modeTabs}>
          <button
            type="button"
            className={`${styles.modeTab} ${!isBuilder ? styles.modeTabActive : ''}`}
            onClick={() => setIsBuilder(false)}
          >
            <Icon name="file" size={20} />
            <span>
              <Typography variant="body-sm" weight="medium" as="span">
                {t('skills.modeSimple')}
              </Typography>
              <Typography variant="caption" color="subtle">
                {t('skills.modeSimpleHint')}
              </Typography>
            </span>
          </button>

          <button
            type="button"
            className={`${styles.modeTab} ${isBuilder ? styles.modeTabActive : ''}`}
            onClick={() => setIsBuilder(true)}
          >
            <Icon name="skills" size={20} />
            <span>
              <Typography variant="body-sm" weight="medium" as="span">
                {t('skills.modeBuilder')}
              </Typography>
              <Typography variant="caption" color="subtle">
                {t('skills.modeBuilderHint')}
              </Typography>
            </span>
          </button>
        </div>
      )}

      <FormWithAssistant
        kind={t('skills.title')}
        fields={{ name, description, body }}
        schema={{
          name: 'Имя скилла латиницей через дефис',
          description:
            'Когда применять скилл: ситуация и слова пользователя. По этому полю Claude решает, подключать ли скилл',
          body: 'Инструкции в markdown: что делать по шагам, чего не делать, как проверить результат',
        }}
        onApply={(applied) => {
          if (typeof applied.name === 'string') setName(applied.name);
          if (typeof applied.description === 'string') setDescription(applied.description);
          if (typeof applied.body === 'string') setBody(applied.body);
        }}
      >
        <Stack gap="var(--spacing-md)">
          <TextField
            label={t('skills.skillName')}
            value={name}
            onChange={setName}
            placeholder="например: perf-audit"
            hint={t('skills.skillNameHint')}
            isMono
            autoFocus={!skill}
            // Имя — это имя папки: у существующего скилла его смена создала бы
            // новую папку и осиротила старую, поэтому правим только новый.
            disabled={Boolean(activeId)}
          />

          <TextField
            label={t('skills.description')}
            value={description}
            onChange={setDescription}
            multiline
            rows={4}
            placeholder="Use КОГДА пользователь просит…"
            hint={t('skills.descriptionHint')}
          />

          <TextField
            label={t('skills.skillBody')}
            value={body}
            onChange={setBody}
            multiline
            rows={isBuilder ? 8 : 12}
            hint={t('skills.skillBodyHint')}
          />

          {(create.isError || update.isError) && (
            <Typography variant="body-sm" color="danger">
              {t('errors.saveFailed')}
            </Typography>
          )}

          {/* Конструктор до создания: выбор заготовки структуры. Разворачивается
              она сразу после того, как скилл появится на диске. */}
          {isBuilder && !activeId && (
            <Stack gap="var(--spacing-3xs)" className={styles.structure}>
              <Typography variant="body-sm" weight="medium">
                {t('skills.pickTemplate')}
              </Typography>
              <Typography variant="caption" color="subtle">
                {t('skills.pickTemplateHint')}
              </Typography>

              <Stack gap="var(--spacing-2xs)">
                {templates.data?.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={`${styles.template} ${templateId === template.id ? styles.templateActive : ''}`}
                    onClick={() =>
                      setTemplateId((current) =>
                        current === template.id ? undefined : template.id,
                      )
                    }
                  >
                    <Stack gap="var(--spacing-3xs)">
                      <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
                        <Typography variant="body-sm" weight="medium" as="span">
                          {template.title}
                        </Typography>
                        <Typography variant="caption" color="subtle" as="span">
                          {template.paths.join(', ')}
                        </Typography>
                      </Stack>
                      <Typography variant="caption" color="muted">
                        {template.description}
                      </Typography>
                    </Stack>
                  </button>
                ))}
              </Stack>
            </Stack>
          )}

          {/* Структура файлов — дерево со всем: шаблоны, помощник, правка,
              создание. Появляется, когда у скилла есть папка на диске. */}
          {activeId && (
            <Stack gap="var(--spacing-3xs)" className={styles.structure}>
              <Typography variant="body-sm" weight="medium">
                {t('skills.structureTitle')}
              </Typography>
              <Typography variant="caption" color="subtle">
                {t('skills.structureHint')}
              </Typography>
              <ResourceFileTree kind="skill" id={activeId} />
            </Stack>
          )}
        </Stack>
      </FormWithAssistant>
    </Modal>
  );
}
