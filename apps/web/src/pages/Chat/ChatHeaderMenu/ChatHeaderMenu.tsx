import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from '@tanstack/react-router';
import { useDraftFromChat } from '@entities/ProjectTest';
import { toast } from '@shared/lib/toast';
import { HELP_ROUTE } from '@shared/config/routes';
import { useAnchoredPanel } from '@shared/hooks/use-anchored-panel';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import type { ChatHeaderMenuProps } from './ChatHeaderMenu.types';
import styles from './ChatHeaderMenu.module.scss';
import { TESTS_ROUTE } from './ChatHeaderMenu.constants';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Меню шапки чата: тумблеры прав, выгрузка разговора, обновление и справка.
 *
 * Всё это стояло в шапке в один ряд и вытесняло оттуда то, ради чего в шапку и
 * смотрят, — название разговора, пульт агентов, выбор модели. Тумблеры при этом
 * трогают редко: положение переживает перезагрузку, и после первой настройки к
 * ним не возвращаются неделями. Поэтому они здесь, за одной кнопкой, а в ряду
 * остаётся работа.
 */
export function ChatHeaderMenu({
  chatId,
  sessionId,
  allowEdits,
  onAllowEditsChange,
  projectPath,
  autoApprove,
  onAutoApproveChange,
  canExport,
  onExport,
  onRefresh,
  onRestartSession,
  restartBlocked,
}: ChatHeaderMenuProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const draftFromChat = useDraftFromChat();
  const [isOpen, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { panelRef, panelStyle } = useAnchoredPanel<HTMLDivElement>(isOpen);

  // Escape закрывает меню и возвращает фокус на кнопку: без возврата клавиатура
  // оказывается в начале страницы, а человек — там, где не был.
  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const showEdits = allowEdits !== undefined && onAllowEditsChange !== undefined;

  return (
    <div
      className={styles.wrap}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && isOpen) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        leftIcon={<Icon name="settings" size={20} />}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        title={t('chat.menuHint')}
      >
        <span data-bar-label="">{t('chat.menu')}</span>
      </Button>

      {isOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            ref={panelRef}
            className={styles.panel}
            style={panelStyle}
            role="dialog"
            aria-label={t('chat.menu')}
          >
            <Typography
              variant="caption"
              color="subtle"
              as="span"
              className={styles.groupTitle}
              id="chat-menu-permissions"
            >
              {t('chat.menuPermissions')}
            </Typography>

            {/* Автоподтверждение: панель сама разрешает обратимое, а
                безвозвратное (удаление, затирание истории, снос данных) и всё
                под правилами ask/deny по-прежнему спрашивает. Чтение файлов
                разрешается всегда — независимо от этого тумблера. */}
            <Stack
              as="label"
              direction="row"
              align="center"
              gap="var(--spacing-2xs)"
              className={styles.row}
              title={t('chat.autoApproveHint')}
            >
              <Toggle
                size="sm"
                checked={autoApprove}
                onCheckedChange={onAutoApproveChange}
                aria-label={t('chat.autoApprove')}
              />
              <Typography variant="body-sm" color={autoApprove ? 'default' : 'subtle'} as="span">
                {autoApprove ? t('chat.autoApproveOn') : t('chat.autoApproveOff')}
              </Typography>
            </Stack>

            {showEdits && (
              <Stack
                as="label"
                direction="row"
                align="center"
                gap="var(--spacing-2xs)"
                className={styles.row}
              >
                <Toggle
                  size="sm"
                  checked={allowEdits}
                  onCheckedChange={onAllowEditsChange}
                  aria-label={t('chat.allowEdits')}
                />
                <Typography variant="body-sm" color={allowEdits ? 'default' : 'subtle'} as="span">
                  {allowEdits ? t('chat.editsAllowed') : t('chat.readOnly')}
                </Typography>
              </Stack>
            )}

            <div className={styles.divider} />

            <Typography variant="caption" color="subtle" as="span" className={styles.groupTitle}>
              {t('chat.menuActions')}
            </Typography>

            {/* Перезапуск сессии стоит первым среди действий: это единственное
                из них, что меняет ход работы, а не показ. Пока идёт прогон —
                погашен с причиной: стереть контекст посреди хода — потерять ход. */}
            {onRestartSession && (
              <button
                type="button"
                className={styles.item}
                disabled={Boolean(restartBlocked)}
                onClick={() => {
                  onRestartSession();
                  close();
                }}
                title={restartBlocked ?? t('chat.handoff.restartHint')}
              >
                <Icon name="swap" size={20} />
                {t('chat.handoff.restart')}
              </button>
            )}

            {/* Кейс из разговора: сценарий, который человек только что прошёл с
                агентом, — черновиком в «Тесты» проекта; принимает его человек. */}
            {canExport && projectPath && (sessionId ?? chatId) && (
              <button
                type="button"
                className={styles.item}
                disabled={draftFromChat.isPending}
                onClick={() => {
                  const id = sessionId ?? chatId;
                  if (!id) return;
                  draftFromChat.mutate(
                    { path: projectPath, chatId: id },
                    {
                      onSuccess: () => {
                        toast.success(t('chat.caseDraftCreated'));
                        void navigate({
                          to: TESTS_ROUTE,
                          search: { tab: 'library', project: projectPath },
                        });
                      },
                      onError: (error) =>
                        toast.error(t('chat.caseDraftFailed', { message: toErrorMessage(error) })),
                    },
                  );
                  close();
                }}
                title={t('chat.caseDraftHint')}
              >
                <Icon name="file" size={20} />
                {t('chat.caseDraft')}
              </button>
            )}

            {canExport && (
              <button
                type="button"
                className={styles.item}
                onClick={() => {
                  onExport();
                  close();
                }}
                title={t('chat.exportHint')}
              >
                <Icon name="file" size={20} />
                {t('chat.export')}
              </button>
            )}

            <button
              type="button"
              className={styles.item}
              onClick={() => {
                onRefresh();
                close();
              }}
            >
              <Icon name="refresh" size={20} />
              {t('common.refresh')}
            </button>

            <Link
              to={HELP_ROUTE}
              search={{ topic: 'chat' }}
              className={styles.item}
              onClick={() => setOpen(false)}
            >
              <Icon name="help" size={20} />
              {t('common.openHelp')}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
