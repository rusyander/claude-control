import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestAttributeDef } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { toErrorMessage } from '@shared/api/client';
import { attributeProblem } from '../model/testSettings';
import type { TestSettingsSectionProps } from './TestSettingsModal.types';
import styles from './ProjectTests.module.scss';

const TYPES: ProjectTestAttributeDef['type'][] = ['text', 'select', 'number'];

const EMPTY: ProjectTestAttributeDef = { key: '', title: '', type: 'text' };

/**
 * Свои поля проекта: колонка в таблице и поле в редакторе кейса.
 *
 * Ключ уезжает в КАЖДЫЙ кейс (`attributes[key]`), поэтому он проверяется здесь
 * же, до отправки: заведённое с ключом «Своё поле» останется в файлах навсегда.
 * Сервер проверяет то же самое — форма лишь говорит об этом раньше.
 *
 * Схема пишется целиком, одним файлом: список здесь и есть содержимое
 * `schema.json`, а собственные статусы проекта из него не трогаются — их правят
 * в файле, и терять их при сохранении полей нельзя.
 */
export function TestSettingsFields({ board, onError }: TestSettingsSectionProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ProjectTestAttributeDef>(EMPTY);
  const [options, setOptions] = useState('');
  const [editing, setEditing] = useState('');
  const [isBusy, setBusy] = useState(false);

  const attributes = board.schema.attributes;
  const patch = (part: Partial<ProjectTestAttributeDef>): void =>
    setDraft((current) => ({ ...current, ...part }));

  const parsedOptions = options
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const candidate: ProjectTestAttributeDef = {
    ...draft,
    key: draft.key.trim(),
    options: draft.type === 'select' ? parsedOptions : undefined,
  };
  const problem = candidate.key ? attributeProblem(candidate, attributes, editing) : undefined;

  const send = async (next: ProjectTestAttributeDef[]): Promise<void> => {
    onError(undefined);
    setBusy(true);
    try {
      await board.saveSchema({ ...board.schema, attributes: next });
    } catch (cause) {
      onError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const reset = (): void => {
    setDraft(EMPTY);
    setOptions('');
    setEditing('');
  };

  const save = async (): Promise<void> => {
    const next = editing
      ? attributes.map((item) => (item.key === editing ? candidate : item))
      : [...attributes, candidate];
    await send(next);
    reset();
  };

  const edit = (attribute: ProjectTestAttributeDef): void => {
    setDraft(attribute);
    setOptions((attribute.options ?? []).join(', '));
    setEditing(attribute.key);
    onError(undefined);
  };

  return (
    <Stack gap="var(--spacing-md)">
      <Stack gap="var(--spacing-2xs)">
        {attributes.length === 0 && (
          <Typography variant="caption" color="subtle">
            {t('tests.settings.field.empty')}
          </Typography>
        )}

        {attributes.map((attribute) => (
          <Stack key={attribute.key} gap="var(--spacing-3xs)" className={styles.secretRow}>
            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Typography weight="medium" as="span">
                {attribute.title}
              </Typography>
              <Typography variant="mono" color="subtle" as="span">
                {attribute.key}
              </Typography>
              <Badge tone="neutral">{t(`tests.settings.field.type.${attribute.type}`)}</Badge>
              {attribute.required && (
                <Badge tone="warning">{t('tests.settings.field.required')}</Badge>
              )}
            </Stack>

            {attribute.options && attribute.options.length > 0 && (
              <Typography variant="caption" color="subtle">
                {attribute.options.join(', ')}
              </Typography>
            )}

            <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
              <Button variant="ghost" size="sm" onClick={() => edit(attribute)}>
                {t('tests.settings.edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Icon name="trash" size={16} />}
                isLoading={isBusy}
                title={t('tests.settings.field.removeHint')}
                onClick={() =>
                  void send(attributes.filter((item) => item.key !== attribute.key)).then(() => {
                    if (editing === attribute.key) reset();
                  })
                }
              >
                {t('tests.settings.remove')}
              </Button>
            </Stack>
          </Stack>
        ))}
      </Stack>

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium">
          {editing
            ? t('tests.settings.field.editTitle', { title: editing })
            : t('tests.settings.field.add')}
        </Typography>
        <Stack direction="row" gap="var(--spacing-xs)" align="start" wrap>
          <div className={styles.halfField}>
            <TextField
              label={t('tests.settings.field.name')}
              placeholder={t('tests.settings.field.namePlaceholder')}
              value={draft.title}
              onChange={(value) => patch({ title: value })}
            />
          </div>
          <div className={styles.halfField}>
            <TextField
              label={t('tests.settings.field.key')}
              hint={t('tests.settings.field.keyHint')}
              placeholder="stand"
              value={draft.key}
              onChange={(value) => patch({ key: value })}
              isMono
            />
          </div>
        </Stack>
        <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap>
          <div className={styles.halfField}>
            <SelectField
              label={t('tests.settings.field.typeLabel')}
              value={draft.type}
              onChange={(value) => patch({ type: value as ProjectTestAttributeDef['type'] })}
              options={TYPES.map((type) => ({
                value: type,
                label: t(`tests.settings.field.type.${type}`),
              }))}
            />
          </div>
          {draft.type === 'select' && (
            <div className={styles.halfField}>
              <TextField
                label={t('tests.settings.field.options')}
                hint={t('tests.settings.field.optionsHint')}
                placeholder="дым, регресс, приёмка"
                value={options}
                onChange={setOptions}
              />
            </div>
          )}
          <Stack direction="row" gap="var(--spacing-2xs)" align="center">
            <Toggle
              aria-label={t('tests.settings.field.requiredLabel')}
              checked={draft.required === true}
              onCheckedChange={(checked) => patch({ required: checked ? true : undefined })}
            />
            <Typography variant="body-sm" as="span">
              {t('tests.settings.field.requiredLabel')}
            </Typography>
          </Stack>
        </Stack>

        {problem && (
          <Typography variant="caption" color="danger">
            {t(`tests.settings.field.problem.${problem}`)}
          </Typography>
        )}

        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <Button
            variant="primary"
            isLoading={isBusy}
            disabled={candidate.key.length === 0 || Boolean(problem)}
            onClick={() => void save()}
          >
            {editing ? t('tests.settings.save') : t('tests.settings.add')}
          </Button>
          {editing && (
            <Button variant="ghost" onClick={reset}>
              {t('tests.settings.cancel')}
            </Button>
          )}
        </Stack>

        <Typography variant="caption" color="subtle">
          {t('tests.settings.field.where')}
        </Typography>
      </Stack>
    </Stack>
  );
}
