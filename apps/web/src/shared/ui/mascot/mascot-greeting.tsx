import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pickTip, useMascotPrefs } from '@shared/lib/mascot';
import { Mascot } from './mascot';
import type { MascotGreetingProps } from './mascot.types';
import styles from './mascot-scenes.module.scss';

/** Сколько Дека машет, встречая на пустом экране; дальше — обычный покой. */
const WAVE_MS = 2_400;

/**
 * Дека на пустом экране (новый чат): машет и даёт совет по месту. Совет —
 * по кнопке следующий, а не по таймеру: текст, который меняется сам, пока его
 * читают, раздражает. Выключен маскот — рисуется то, что было здесь до него.
 */
export function MascotGreeting({ fallback, scope }: MascotGreetingProps) {
  const { t } = useTranslation();
  const prefs = useMascotPrefs();
  const [tip, setTip] = useState(() => pickTip(scope));
  const [isWaving, setWaving] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setWaving(false), WAVE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!prefs.enabled) return <>{fallback}</>;

  return (
    <div className={styles.greeting} data-mascot-greeting>
      <Mascot mood={isWaving ? 'waving' : 'idle'} size={72} />
      {prefs.chatty && (
        <div className={styles.tip}>
          <span className={styles.tipLabel}>{t('mascot.greeting.tip')}</span>
          <span data-mascot-tip={tip}>{t(`mascot.tips.${tip}`)}</span>
          <button
            type="button"
            className={styles.tipNext}
            onClick={() => setTip((current) => pickTip(scope, current))}
            data-mascot-next-tip
          >
            {t('mascot.greeting.next')}
          </button>
        </div>
      )}
    </div>
  );
}
