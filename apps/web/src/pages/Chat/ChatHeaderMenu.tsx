import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { PERMISSION_RULE_IDS, resolvePermissionRules } from '@agentdeck/contracts';
import { useSettings, useUpdateSettings } from '@entities/AppConfig';
import { useCascadeRule, useSetCascadeRule } from '@entities/ChatSplit';
import { HELP_ROUTE } from '@shared/config/routes';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Toggle } from '@shared/ui/toggle';
import type { ChatHeaderMenuProps } from './ChatHeaderMenu.types';
import styles from './ChatHeaderMenu.module.scss';

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
  const [isOpen, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Правила прав живут в настройках ПАНЕЛИ, а не в разговоре: решение «пусть
  // агент сам пишет комментарии в MR» относится к человеку и его сервисам, и
  // повторять его в каждом проекте и на телефоне он не должен.
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const rules = resolvePermissionRules(settings?.autoApproveRules);
  const setRule = (id: string, enabled: boolean): void => {
    updateSettings.mutate({
      autoApproveRules: { ...(settings?.autoApproveRules ?? {}), [id]: enabled },
    });
  };

  // Подбор модели под задачу — правило ПРОЕКТА, поэтому оно и не в настройках
  // панели: цена ошибки у репозиториев разная. Пока ответ не пришёл, показываем
  // включённым — это умолчание, и мигать «выключено» на каждом открытии меню
  // значило бы врать о состоянии.
  const cascade = useCascadeRule(projectPath);
  const setCascade = useSetCascadeRule(projectPath);
  const cascadeOn = cascade.data?.enabled ?? true;

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
        {t('chat.menu')}
      </Button>

      {isOpen && (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.panel} role="dialog" aria-label={t('chat.menu')}>
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

            {/* Правила прав: та же граница «что разрешать самой», но её кладёт
                человек и один раз на все проекты. Включённое правило снимает
                карточку «Разрешить/Запретить», выключенное — возвращает её;
                права `ask`/`deny` из settings.json сильнее любого тумблера. */}
            <Typography
              variant="caption"
              color="subtle"
              as="span"
              className={styles.groupTitle}
              id="chat-menu-rules"
            >
              {t('chat.rules.title')}
            </Typography>

            {/* Подбор модели под задачу. Стоит первым среди правил и отделён от
                них по смыслу: остальные решают, что панель разрешает БЕЗ
                вопроса, а это — чем именно будет сделана работа. Выключенное
                возвращает прежнее поведение: все дети разделения едут на
                модели, которую выбрал человек. */}
            {projectPath && (
              <Stack as="label" direction="row" className={styles.ruleRow}>
                <Toggle
                  size="sm"
                  checked={cascadeOn}
                  onCheckedChange={(next) => setCascade.mutate(next)}
                  aria-label={t('chat.rules.modelCascade')}
                />
                <span className={styles.ruleText}>
                  <Typography variant="body-sm" color={cascadeOn ? 'default' : 'subtle'} as="span">
                    {t('chat.rules.modelCascade')}
                  </Typography>
                  <Typography variant="caption" color="subtle" as="span">
                    {t('chat.rules.modelCascadeHint')}
                  </Typography>
                </span>
              </Stack>
            )}

            {PERMISSION_RULE_IDS.map((id) => (
              <Stack key={id} as="label" direction="row" className={styles.ruleRow}>
                <Toggle
                  size="sm"
                  checked={rules[id]}
                  onCheckedChange={(next) => setRule(id, next)}
                  aria-label={t(`chat.rules.${id}`)}
                />
                <span className={styles.ruleText}>
                  <Typography variant="body-sm" color={rules[id] ? 'default' : 'subtle'} as="span">
                    {t(`chat.rules.${id}`)}
                  </Typography>
                  <Typography variant="caption" color="subtle" as="span">
                    {t(`chat.rules.${id}Hint`)}
                  </Typography>
                </span>
              </Stack>
            ))}

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
