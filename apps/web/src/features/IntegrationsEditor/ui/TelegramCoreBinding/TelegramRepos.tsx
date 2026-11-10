import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigView } from '@agentdeck/contracts/core/config';
import { boardMoveRefusalOf } from '@entities/CoreTask';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { Typography } from '@shared/ui/typography';
import { useSetTelegramRepos, useTelegramCoreConfig } from '../../api/telegramCoreBindingApi';
import { TELEGRAM_REPOS_MAX, parseReposText, reposText } from '../../model/telegramCoreBinding';
import styles from './TelegramCoreBinding.module.scss';

const P = 'telegramAnswers.core';

/** Черновик поля и вид настройки, от которого его начали править: запись судится его отпечатком. */
interface Draft {
  text: string;
  base: ConfigView;
}

/**
 * Репозитории записей `/task` (этап 12, W2-D): запись из Telegram несёт их и стартует кнопкой
 * «В работу» без выбора на доске. Пусто — запись ждёт репозиторий на доске, кнопки в Telegram нет.
 * Пишет окно панели в `telegram.repos` настройки ядра (`set-config`, только человек) от того вида,
 * который человек видел: настройку изменили мимо — ядро 409, поле предлагает перечитать.
 */
export function TelegramRepos({ enabled }: { enabled: boolean }): ReactNode {
  const { t } = useTranslation();
  const config = useTelegramCoreConfig(enabled);
  const save = useSetTelegramRepos();
  // null — поле не трогали: показывает действующую настройку и следует за ней.
  const [draft, setDraft] = useState<Draft | null>(null);
  if (!enabled || !config.data) return null;
  const current = config.data;
  const base = draft?.base ?? current;
  const saved = reposText(base.doc.telegram?.repos);
  const text = draft?.text ?? saved;
  const parsed = parseReposText(text);
  const error =
    'error' in parsed ? t(`${P}.repos.${parsed.error}`, { max: TELEGRAM_REPOS_MAX }) : undefined;
  const changed = 'repos' in parsed && reposText(parsed.repos) !== saved;
  const refusal = save.isError ? boardMoveRefusalOf(save.error) : undefined;

  // Перечитать: черновик снят, поле показывает свежую настройку — правка поля сознательно теряется.
  const reload = async () => {
    await config.refetch();
    setDraft(null);
    save.reset();
  };

  return (
    <div className={styles.repos} data-telegram-repos>
      <TextField
        label={t(`${P}.repos.label`)}
        hint={t(`${P}.repos.hint`)}
        placeholder={t(`${P}.repos.placeholder`)}
        value={text}
        onChange={(next) => setDraft((prev) => ({ text: next, base: prev?.base ?? current }))}
        multiline
        rows={3}
        isMono
        error={error}
      />
      <div className={styles.row}>
        <Button
          variant="secondary"
          size="sm"
          disabled={!changed || save.isPending}
          isLoading={save.isPending}
          onClick={() => {
            if ('repos' in parsed)
              save.mutate({ base, repos: parsed.repos }, { onSuccess: () => setDraft(null) });
          }}
        >
          {t(`${P}.repos.save`)}
        </Button>
        {refusal?.status === 409 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void reload()}
            data-telegram-repos-reload
          >
            {t(`${P}.repos.reload`)}
          </Button>
        ) : null}
      </div>
      {refusal ? (
        <Typography
          variant="caption"
          color="danger"
          as="span"
          role="alert"
          data-telegram-repos-error
        >
          {t(`${P}.repos.failed`, { reason: refusal.reason })}
        </Typography>
      ) : null}
    </div>
  );
}
