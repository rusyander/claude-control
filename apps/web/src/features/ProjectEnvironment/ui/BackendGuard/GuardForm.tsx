import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useInstallBackendGuard,
  useRemoveBackendGuard,
  useSaveBackendGuardSettings,
  type BackendGuardRule,
  type BackendGuardSettings,
} from '@entities/BackendGuard';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { guardErrorText, parseMarkers, settingsKey, shortMarkers } from '../../lib/guardError';
import { GuardCheck } from './GuardCheck';
import { GuardRemoveZone } from './GuardRemoveZone';
import { GuardRules } from './GuardRules';
import { GuardStatusCard } from './GuardStatusCard';
import type { GuardFormProps } from './BackendGuard.types';
import styles from './BackendGuard.module.scss';

/**
 * Черновик настроек поверх сохранённых. Пока защиты нет, та же форма готовит
 * установку — человек видит, ЧТО будет спрашивать, до того как поставит.
 * Проверка команды идёт по черновику: «а эта спросит?» до сохранения.
 */
export function GuardForm({ projectPath, status, notice, onNotice }: GuardFormProps) {
  const { t, i18n } = useTranslation();
  const install = useInstallBackendGuard();
  const save = useSaveBackendGuardSettings();
  const remove = useRemoveBackendGuard();
  const [markersText, setMarkersText] = useState(status.settings.prodMarkers.join('\n'));
  const [disabled, setDisabled] = useState<BackendGuardRule[]>(status.settings.disabled);
  const [failure, setFailure] = useState<string>();
  const noticeRef = useRef<HTMLParagraphElement>(null);

  // Форма собирается заново после каждого действия, а нажатая кнопка могла
  // исчезнуть («Поставить» → «Сохранить») — фокус уходит на итог, не в никуда.
  useEffect(() => {
    noticeRef.current?.focus();
  }, []);

  const markers = parseMarkers(markersText);
  const tooShort = shortMarkers(markers);
  const draft: BackendGuardSettings = { prodMarkers: markers, disabled };
  const isInstalled = status.state !== 'none';
  const isDirty = settingsKey(draft) !== settingsKey(status.settings);
  const isBusy = install.isPending || save.isPending || remove.isPending;
  const canSubmit = tooShort.length === 0 && !isBusy;

  const handlers = (done: string) => ({
    onSuccess: () => onNotice(done),
    onError: (error: unknown) => setFailure(guardErrorText(error, t)),
  });
  const start = () => {
    setFailure(undefined);
    onNotice(undefined);
  };
  const doInstall = () => {
    start();
    install.mutate(
      { path: projectPath, settings: draft, lang: i18n.language === 'en' ? 'en' : 'ru' },
      handlers(t('environment.guard.actions.installed')),
    );
  };

  return (
    <div className={styles.panel}>
      {notice && (
        <p ref={noticeRef} tabIndex={-1} role="status" className={styles.done}>
          <Icon name="check" size={16} />
          {notice}
        </p>
      )}

      <GuardStatusCard status={status} isBusy={isBusy} onRestore={doInstall} />

      <div className={styles.columns}>
        <GuardRules
          disabled={disabled}
          onToggle={(rule, isOn) =>
            setDisabled((list) => (isOn ? list.filter((item) => item !== rule) : [...list, rule]))
          }
        />
        <div className={styles.side}>
          <section className={styles.block} aria-labelledby="guard-prod-title">
            <h3 id="guard-prod-title" className={styles.sectionTitle}>
              {t('environment.guard.prod.title')}
            </h3>
            <TextField
              label={t('environment.guard.prod.label')}
              value={markersText}
              onChange={setMarkersText}
              multiline
              rows={4}
              isMono
              placeholder={t('environment.guard.prod.placeholder')}
              hint={t('environment.guard.prod.hint')}
              {...(tooShort.length > 0
                ? { error: t('environment.guard.prod.tooShort', { markers: tooShort.join(', ') }) }
                : {})}
            />
          </section>
          <GuardCheck
            settings={{
              prodMarkers: markers.filter((marker) => !tooShort.includes(marker)),
              disabled,
            }}
          />
        </div>
      </div>

      {failure && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}

      <div className={styles.actions}>
        {isInstalled ? (
          <>
            <Button
              variant="primary"
              size="sm"
              isLoading={save.isPending}
              disabled={!isDirty || !canSubmit}
              onClick={() => {
                start();
                save.mutate(
                  { path: projectPath, settings: draft },
                  handlers(t('environment.guard.actions.saved')),
                );
              }}
            >
              {t('environment.guard.actions.save')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!isDirty || isBusy}
              onClick={() => {
                setMarkersText(status.settings.prodMarkers.join('\n'));
                setDisabled(status.settings.disabled);
              }}
            >
              {t('environment.guard.actions.revert')}
            </Button>
            {isDirty && (
              <span className={styles.sub} aria-live="polite">
                {t('environment.guard.actions.dirty')}
              </span>
            )}
          </>
        ) : (
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="lock" size={16} />}
            isLoading={install.isPending}
            disabled={!canSubmit}
            onClick={doInstall}
          >
            {t('environment.guard.actions.install')}
          </Button>
        )}
      </div>

      {isInstalled && (
        <GuardRemoveZone
          groupName={status.groupName ?? ''}
          isBusy={isBusy}
          onRemove={() => {
            start();
            remove.mutate({ path: projectPath }, handlers(t('environment.guard.actions.removed')));
          }}
        />
      )}
    </div>
  );
}
