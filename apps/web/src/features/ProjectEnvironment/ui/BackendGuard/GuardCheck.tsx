import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCheckBackendGuard } from '@entities/BackendGuard';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { guardErrorText } from '../../lib/guardError';
import type { GuardCheckProps } from './BackendGuard.types';
import styles from './BackendGuard.module.scss';

/**
 * «А эта спросит?» — команду проверяет тот же классификатор, что работает
 * хуком, по настройкам с экрана. Ответ гаснет при правке команды или настроек:
 * вердикт к другому тексту — ложь.
 */
export function GuardCheck({ settings }: GuardCheckProps) {
  const { t } = useTranslation();
  const check = useCheckBackendGuard();
  const [command, setCommand] = useState('');
  const [checked, setChecked] = useState<string>();
  const fingerprint = `${command}\u0000${settings.prodMarkers.join('\n')}\u0000${settings.disabled.join(',')}`;
  const isFresh = checked === fingerprint;
  const hit = isFresh ? check.data?.hit : undefined;

  const submit = () => {
    if (!command.trim()) return;
    check.mutate({ command, settings }, { onSuccess: () => setChecked(fingerprint) });
  };

  return (
    <section className={styles.block} aria-labelledby="guard-check-title">
      <h3 id="guard-check-title" className={styles.sectionTitle}>
        {t('environment.guard.check.title')}
      </h3>
      <form
        className={styles.check}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className={styles.checkField}>
          <TextField
            label={t('environment.guard.check.label')}
            value={command}
            onChange={setCommand}
            isMono
            placeholder={t('environment.guard.check.placeholder')}
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          isLoading={check.isPending}
          disabled={!command.trim()}
        >
          {t('environment.guard.check.button')}
        </Button>
      </form>
      <p className={styles.sub}>{t('environment.guard.check.hint')}</p>
      <div aria-live="polite">
        {check.isError && (
          <p className={styles.error} role="alert">
            {guardErrorText(check.error, t)}
          </p>
        )}
        {isFresh && !check.isError && (
          <p className={styles.verdict} data-verdict={hit ? 'asks' : 'passes'}>
            {hit
              ? t('environment.guard.check.asks', {
                  reason: t(`environment.guard.rules.${hit.rule}.title`),
                  match: hit.match,
                })
              : t('environment.guard.check.passes')}
          </p>
        )}
      </div>
    </section>
  );
}
