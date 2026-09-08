import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestEnvironment } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { TextField } from '@shared/ui/text-field';
import { toErrorMessage } from '@shared/api/client';
import { plansUsingEnvironment, sortEnvironments } from '../model/testSettings';
import { TestSecretsModal } from './TestSecretsModal';
import type { TestSettingsSectionProps } from './TestSettingsModal.types';
import styles from './ProjectTests.module.scss';

/** Пустая заготовка окружения: название человек вводит сам, остальное необязательно. */
const EMPTY: ProjectTestEnvironment = { id: '', title: '' };

/**
 * Окружения набора: где именно прогоняют.
 *
 * Файл `environments.json` едет в git вместе с кейсами, поэтому здесь только то,
 * что можно показать команде: адрес, браузер, система, команда подъёма. Пароли
 * стенда живут отдельно и вводятся кнопкой «Доступы» тем же окном, что и перед
 * прогоном, — второго места для одного окружения не заводится.
 */
export function TestSettingsEnvironments({ board, onError }: TestSettingsSectionProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ProjectTestEnvironment>(EMPTY);
  /** Какое окружение сейчас правят: пусто — заводят новое. */
  const [editing, setEditing] = useState('');
  /** У какого окружения спросили подтверждение удаления. */
  const [removing, setRemoving] = useState('');
  const [secretsFor, setSecretsFor] = useState('');
  const [isBusy, setBusy] = useState(false);

  const items = sortEnvironments(board.environments);
  const secretsEnvironment = board.environments.find((item) => item.id === secretsFor);

  const patch = (part: Partial<ProjectTestEnvironment>): void =>
    setDraft((current) => ({ ...current, ...part }));

  const send = async (action: () => Promise<unknown>): Promise<void> => {
    onError(undefined);
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      onError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<void> =>
    send(async () => {
      await board.saveEnvironment({ ...draft, title: draft.title.trim() });
      setDraft(EMPTY);
      setEditing('');
    });

  const edit = (environment: ProjectTestEnvironment): void => {
    setDraft(environment);
    setEditing(environment.id);
    setRemoving('');
    onError(undefined);
  };

  const remove = (id: string, force: boolean): Promise<void> =>
    send(async () => {
      await board.removeEnvironment(id, force);
      setRemoving('');
      if (editing === id) {
        setDraft(EMPTY);
        setEditing('');
      }
    });

  return (
    <Stack gap="var(--spacing-md)">
      <Stack gap="var(--spacing-2xs)">
        {items.length === 0 && (
          <Typography variant="caption" color="subtle">
            {t('tests.settings.env.empty')}
          </Typography>
        )}

        {items.map((environment) => {
          const usedBy = plansUsingEnvironment(board.plans, environment.id);
          return (
            <Stack key={environment.id} gap="var(--spacing-3xs)" className={styles.secretRow}>
              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Typography weight="medium" as="span">
                  {environment.title}
                </Typography>
                <Typography variant="mono" color="subtle" as="span">
                  {environment.id}
                </Typography>
                {environment.isDefault && (
                  <Badge tone="success">{t('tests.settings.env.default')}</Badge>
                )}
                {environment.archived && (
                  <Badge tone="neutral">{t('tests.settings.env.archived')}</Badge>
                )}
                {environment.secrets && environment.secrets.length > 0 && (
                  <Badge tone="info">
                    {t('tests.settings.env.secretCount', { count: environment.secrets.length })}
                  </Badge>
                )}
              </Stack>

              {environment.baseUrl && (
                <Typography variant="caption" color="subtle">
                  {environment.baseUrl}
                </Typography>
              )}

              <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                <Button variant="ghost" size="sm" onClick={() => edit(environment)}>
                  {t('tests.settings.edit')}
                </Button>
                {!environment.isDefault && !environment.archived && (
                  <Button
                    variant="ghost"
                    size="sm"
                    isLoading={isBusy}
                    title={t('tests.settings.env.makeDefaultHint')}
                    onClick={() =>
                      void send(() => board.saveEnvironment({ ...environment, isDefault: true }))
                    }
                  >
                    {t('tests.settings.env.makeDefault')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  isLoading={isBusy}
                  onClick={() =>
                    void send(() =>
                      board.saveEnvironment({ ...environment, archived: !environment.archived }),
                    )
                  }
                >
                  {environment.archived
                    ? t('tests.settings.env.unarchive')
                    : t('tests.settings.env.archive')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSecretsFor(environment.id)}>
                  {t('tests.settings.env.secrets')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name="trash" size={16} />}
                  onClick={() => setRemoving(removing === environment.id ? '' : environment.id)}
                >
                  {t('tests.settings.remove')}
                </Button>
              </Stack>

              {/* Подтверждение спрашивается ЗДЕСЬ и называет планы поимённо:
                  окружение, убранное молча, превращает план в «прогнать
                  неизвестно где», и замечают это только на самом прогоне. */}
              {removing === environment.id && (
                <Stack gap="var(--spacing-3xs)">
                  <Typography variant="caption" color={usedBy.length > 0 ? 'warning' : 'subtle'}>
                    {usedBy.length > 0
                      ? t('tests.settings.env.usedByPlans', {
                          plans: usedBy.map((plan) => plan.title).join(', '),
                        })
                      : t('tests.settings.env.removeHint')}
                  </Typography>
                  <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
                    <Button
                      variant="danger"
                      size="sm"
                      isLoading={isBusy}
                      onClick={() => void remove(environment.id, usedBy.length > 0)}
                    >
                      {t('tests.settings.removeConfirm')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRemoving('')}>
                      {t('tests.settings.cancel')}
                    </Button>
                  </Stack>
                </Stack>
              )}
            </Stack>
          );
        })}
      </Stack>

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="body-sm" weight="medium">
          {editing
            ? t('tests.settings.env.editTitle', { title: editing })
            : t('tests.settings.env.add')}
        </Typography>
        <Stack direction="row" gap="var(--spacing-xs)" align="start" wrap>
          <div className={styles.halfField}>
            <TextField
              label={t('tests.settings.env.name')}
              placeholder={t('tests.settings.env.namePlaceholder')}
              value={draft.title}
              onChange={(value) => patch({ title: value })}
            />
          </div>
          <div className={styles.halfField}>
            <TextField
              label={t('tests.settings.env.url')}
              placeholder="https://stand.local"
              value={draft.baseUrl ?? ''}
              onChange={(value) => patch({ baseUrl: value })}
            />
          </div>
        </Stack>
        <Stack direction="row" gap="var(--spacing-xs)" align="start" wrap>
          <div className={styles.halfField}>
            <TextField
              label={t('tests.settings.env.browser')}
              placeholder="Chrome 130"
              value={draft.browser ?? ''}
              onChange={(value) => patch({ browser: value })}
            />
          </div>
          <div className={styles.halfField}>
            <TextField
              label={t('tests.settings.env.os')}
              placeholder="Windows 11"
              value={draft.os ?? ''}
              onChange={(value) => patch({ os: value })}
            />
          </div>
        </Stack>
        <Stack direction="row" gap="var(--spacing-xs)" align="end" wrap>
          <div className={styles.halfField}>
            <TextField
              label={t('tests.settings.env.start')}
              hint={t('tests.settings.env.startHint')}
              placeholder="pnpm dev"
              value={draft.start ?? ''}
              onChange={(value) => patch({ start: value })}
              isMono
            />
          </div>
          <Button
            variant="primary"
            isLoading={isBusy}
            disabled={draft.title.trim().length === 0}
            onClick={() => void save()}
          >
            {editing ? t('tests.settings.save') : t('tests.settings.add')}
          </Button>
          {editing && (
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(EMPTY);
                setEditing('');
              }}
            >
              {t('tests.settings.cancel')}
            </Button>
          )}
        </Stack>
      </Stack>

      {/* Доступы — то же самое окно, что открывается перед прогоном: заводить
          второе место ввода для одного окружения нельзя, пароль тогда живёт
          в двух формах и расходится. */}
      {secretsEnvironment && (
        <TestSecretsModal
          isOpen
          onOpenChange={(open) => !open && setSecretsFor('')}
          path={board.path}
          environment={secretsEnvironment}
        />
      )}
    </Stack>
  );
}
