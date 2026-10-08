import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectTestE2eSync } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { useCreateE2eFolder, useRemoveE2eFolder, useSyncE2eFolder } from '@entities/ProjectTest';
import { TestE2eRun } from '../TestE2eRun/TestE2eRun';
import { TestMutationCheck } from '../TestMutationCheck/TestMutationCheck';
import type { TestE2eCardProps } from './TestE2eCard.types';
import styles from './TestE2eCard.module.scss';
import { automatedFiles } from '../../lib/automatedFiles';
import { toErrorMessage } from '../../../../shared/api/toErrorMessage';

/**
 * Карточка папки e2e: где лежат НАСТОЯЩИЕ тесты проекта и что из них уже кейсы.
 *
 * Кейсы раздела и код тестов живут порознь (`.agent/tests/` и папка e2e), и без
 * этой строки человек не видит, что агент чата написал тесты, а раздел о них
 * ещё не знает. «Обновить из папки» — то же, что `pnpm tests sync`.
 *
 * Убрать можно только папку, заведённую панелью: своя папка проекта — чужая
 * работа. Чужие файлы в заведённой папке — отдельный шаг с подтверждением прямо
 * в карточке: `confirm()` в панели не показывается. «Прогнать автотесты» —
 * `TestE2eRun`: команда каркаса без агента, итог — строка истории.
 */
export function TestE2eCard({ board, environmentId }: TestE2eCardProps) {
  const { t } = useTranslation();
  const folder = board.e2e;
  const create = useCreateE2eFolder(board.path);
  const remove = useRemoveE2eFolder(board.path);
  const sync = useSyncE2eFolder(board.path);
  const [synced, setSynced] = useState<ProjectTestE2eSync | undefined>();
  /** Сколько чужих файлов назвал отказ 409 — пока не ноль, карточка спрашивает. */
  const [foreign, setForeign] = useState(0);
  const isRunning = board.run?.status === 'running';
  // Убрать папку, пока агент пишет в неё спеки или раннер их гоняет (включая
  // остановленный, который ещё закрывается), — стереть идущую работу.
  const removeLocked = isRunning || Boolean(board.e2eRun && !board.e2eRun.finishedAt);

  if (!folder) return null;

  const failure = create.error ?? remove.error ?? sync.error;
  /**
   * Новое действие — чистый лист: отказ прошлой сверки иначе висел бы под
   * карточкой и после удавшейся уборки, выдавая старую беду за новую.
   */
  const fresh = () => {
    create.reset();
    remove.reset();
    sync.reset();
    setSynced(undefined);
  };
  const onRemove = (force: boolean) => {
    fresh();
    remove.mutate(
      { force },
      {
        onSuccess: () => setForeign(0),
        onError: (error) => {
          const data = (error as { response?: { status?: number; data?: { params?: unknown } } })
            .response;
          const count = Number((data?.data?.params as { count?: number } | undefined)?.count);
          if (data?.status === 409 && count > 0) setForeign(count);
        },
      },
    );
  };

  const facts =
    folder.state === 'missing'
      ? []
      : [
          t(`testsE2e.framework.${folder.framework}`),
          t('testsE2e.specs', { count: folder.specs }),
          folder.excluded ? t('testsE2e.hidden') : '',
          folder.git ? '' : t('testsE2e.notGit'),
        ].filter(Boolean);

  return (
    <Stack gap="var(--spacing-2xs)" className={styles.e2eCard} data-testid="tests-e2e-card">
      {/* Заголовок коротким словом, состояние — строкой под ним: длинная фраза
          рядом с иконкой на 400 px уходила вниз, оставляя иконку одну. */}
      <Stack direction="row" gap="var(--spacing-xs)" align="center">
        <Icon name="folder" size={18} />
        <Typography variant="body" weight="medium" as="h3">
          {t('testsE2e.title')}
        </Typography>
      </Stack>
      <Typography variant="body" as="p">
        {folder.state === 'missing'
          ? t('testsE2e.missing')
          : t(folder.state === 'created' ? 'testsE2e.created' : 'testsE2e.found', {
              dir: `${folder.dir}/`,
            })}
      </Typography>
      {facts.length > 0 && (
        <Typography variant="caption" color="subtle">
          {facts.join(' · ')}
        </Typography>
      )}
      {/* Что сделает кнопка — видимым текстом: у касания подсказок нет. */}
      {folder.state === 'missing' && (
        <Typography variant="caption" color="subtle">
          {t('testsE2e.missingHint')}
        </Typography>
      )}

      {folder.candidates && folder.candidates.length > 0 && (
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Typography variant="caption" color="subtle" as="span">
            {t('testsE2e.candidates')}
          </Typography>
          {folder.candidates.map((dir) => (
            <Button
              key={dir}
              variant="ghost"
              size="sm"
              title={t('testsE2e.chooseHint')}
              disabled={isRunning || sync.isPending}
              onClick={() => {
                fresh();
                sync.mutate({ dir }, { onSuccess: (data) => setSynced(data.sync) });
              }}
            >
              {t('testsE2e.choose', { dir: `${dir}/` })}
            </Button>
          ))}
        </Stack>
      )}

      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        {folder.state === 'missing' ? (
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="plus" size={16} />}
            title={t('testsE2e.createHint')}
            isLoading={create.isPending}
            onClick={() => {
              fresh();
              create.mutate();
            }}
          >
            {t('testsE2e.create')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="refresh" size={16} />}
            title={t('testsE2e.syncHint')}
            disabled={isRunning}
            isLoading={sync.isPending}
            onClick={() => {
              fresh();
              sync.mutate({}, { onSuccess: (data) => setSynced(data.sync) });
            }}
          >
            {t('testsE2e.sync')}
          </Button>
        )}
        {folder.state === 'created' && foreign === 0 && (
          <Button
            variant="ghost"
            size="sm"
            title={t('testsE2e.removeHint')}
            disabled={removeLocked}
            isLoading={remove.isPending}
            onClick={() => onRemove(false)}
          >
            {t('testsE2e.remove')}
          </Button>
        )}
      </Stack>

      {foreign > 0 && (
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap role="alert">
          <Typography variant="caption" color="warning" as="span">
            {t('testsE2e.removeForeign', { count: foreign })}
          </Typography>
          <Button
            variant="danger"
            size="sm"
            disabled={removeLocked}
            isLoading={remove.isPending}
            onClick={() => onRemove(true)}
          >
            {t('testsE2e.removeForce')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            // Отказ 409 снимается вместе с вопросом: иначе строка ошибки
            // оставалась под карточкой, будто уборка сломалась.
            onClick={() => {
              remove.reset();
              setForeign(0);
            }}
          >
            {t('testsE2e.cancel')}
          </Button>
        </Stack>
      )}

      {synced && (
        <Typography variant="caption" color="subtle" role="status">
          {[
            t('testsE2e.syncDone', {
              files: synced.files,
              tests: synced.tests,
              added: synced.added,
              linked: synced.linked,
            }),
            synced.missing.length > 0
              ? t('testsE2e.syncMissing', { count: synced.missing.length })
              : '',
            synced.skipped.length > 0
              ? t('testsE2e.syncSkipped', { count: synced.skipped.length })
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
        </Typography>
      )}

      {failure && foreign === 0 && (
        <Typography variant="caption" color="danger" role="alert">
          {toErrorMessage(failure)}
        </Typography>
      )}

      {(folder.state !== 'missing' || board.automation) && (
        <TestE2eRun
          path={board.path}
          folder={folder}
          run={board.e2eRun}
          environmentId={environmentId}
          isAgentRunning={isRunning}
          automation={board.automation}
          group={
            board.active && {
              id: board.active.id,
              title: board.active.title,
              files: automatedFiles(board.active).length,
              paths: automatedFiles(board.active),
            }
          }
        />
      )}

      {(folder.state !== 'missing' || board.automation) && (
        <TestMutationCheck
          path={board.path}
          isBusy={isRunning || board.e2eRun?.status === 'running'}
        />
      )}
    </Stack>
  );
}
