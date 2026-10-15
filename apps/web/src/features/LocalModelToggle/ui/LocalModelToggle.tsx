import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { LOCAL_MODELS_ROUTE } from '@shared/config/routes';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { toast } from '@shared/lib/toast';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Modal } from '@shared/ui/modal';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';
import { useLocalModels, useToggleLocal } from '@entities/LocalModels';
import { localToggleState } from '../model/toggleState';
import type { LocalModelToggleProps } from './LocalModelToggle.types';
import styles from './LocalModelToggle.module.scss';

/**
 * Одна кнопка в шапке чата: локальная модель включена — чаты идут на свою видеокарту,
 * выключена — в облако (владелец, 15.10). Включение берёт модель, выбранную агентам, со
 * всеми её настройками и не ждёт загрузки: контур включается сразу, сервер грузит модель
 * в фоне, и кнопка говорит «загружается», пока она не готова. Нечего включать — окно
 * с причиной на КАЖДОЕ нажатие и дорогой туда, где это чинится.
 */
function isStarting(data: LocalModelsInfo | undefined): boolean {
  const state = localToggleState(data);
  return state.kind === 'ready' && state.starting;
}

export function LocalModelToggle({ className }: LocalModelToggleProps) {
  const { t } = useTranslation();
  const [explain, setExplain] = useState(false);
  const toggle = useToggleLocal();
  // Пока модель грузится — опрос раз в секунду, иначе «загружается» висело бы до десяти секунд.
  const { data } = useLocalModels({ fastWhen: isStarting });
  const state = localToggleState(data);
  const starting = state.kind === 'ready' && state.starting;

  if (state.kind === 'unknown') return null;

  const failed = (error: unknown): void => {
    toast.error(t('chat.localToggle.failed', { reason: toErrorMessage(error) }));
  };

  const onClick = (): void => {
    if (state.kind === 'blocked') {
      setExplain(true);
      return;
    }
    toggle.mutate({ on: !state.active }, { onError: failed });
  };

  const active = state.kind === 'ready' && state.active;
  const title = state.kind === 'ready' ? state.title : '';
  const hint = toggleHint();

  function toggleHint(): string {
    if (state.kind === 'blocked') return t('chat.localToggle.offHintBlocked');
    if (starting) return t('chat.localToggle.startingHint', { title });
    return active
      ? t('chat.localToggle.onHint', { title })
      : t('chat.localToggle.offHint', { title });
  }

  return (
    <>
      <Button
        variant={active ? 'primary' : 'secondary'}
        size="sm"
        className={className}
        leftIcon={<Icon name="server" size={16} />}
        isLoading={toggle.isPending}
        aria-pressed={active}
        title={hint}
        onClick={onClick}
      >
        <span className={styles.label}>{active ? title : t('chat.localToggle.off')}</span>
        {starting && <span className={styles.state}> · {t('chat.localToggle.starting')}</span>}
      </Button>

      {state.kind === 'blocked' && (
        <Modal
          isOpen={explain}
          onOpenChange={setExplain}
          size="fit"
          title={t('chat.localToggle.blockedTitle')}
          footer={
            <div className={styles.actions}>
              <Link
                to={LOCAL_MODELS_ROUTE}
                search={{ tab: state.reason === 'agents' ? 'agents' : 'models' }}
                onClick={() => setExplain(false)}
              >
                <Typography variant="body-sm" color="accent">
                  {t(
                    state.reason === 'agents'
                      ? 'chat.localToggle.goAgents'
                      : 'chat.localToggle.goModels',
                  )}
                </Typography>
              </Link>
            </div>
          }
        >
          <Stack gap="var(--spacing-sm)">
            <Typography variant="body-sm">
              {t(`chat.localToggle.blocked.${state.reason}`)}
            </Typography>
            {state.reason === 'agents' && (
              <div className={styles.actions}>
                {state.installed.map((item) => (
                  <Button
                    key={item.tag}
                    size="sm"
                    variant="secondary"
                    isLoading={toggle.isPending && toggle.variables?.tag === item.tag}
                    disabled={toggle.isPending}
                    onClick={() =>
                      toggle.mutate(
                        { on: true, tag: item.tag },
                        { onSuccess: () => setExplain(false), onError: failed },
                      )
                    }
                  >
                    {t('chat.localToggle.enable', { title: item.title })}
                  </Button>
                ))}
              </div>
            )}
          </Stack>
        </Modal>
      )}
    </>
  );
}
