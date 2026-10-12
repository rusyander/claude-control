import { useTranslation } from 'react-i18next';
import { BACKEND_GUARD_RULES } from '@entities/BackendGuard';
import { Toggle } from '@shared/ui/toggle';
import type { GuardRulesProps } from './BackendGuard.types';
import styles from './BackendGuard.module.scss';

/**
 * Правила с примерами команд: без примеров «изменение инфраструктуры» не
 * говорит, спросит ли агент перед `kubectl get` (нет) или `kubectl apply` (да).
 */
export function GuardRules({ disabled, onToggle }: GuardRulesProps) {
  const { t } = useTranslation();
  return (
    <section className={styles.block} aria-labelledby="guard-rules-title">
      <h3 id="guard-rules-title" className={styles.sectionTitle}>
        {t('environment.guard.rulesTitle')}
      </h3>
      <p className={styles.sub}>{t('environment.guard.rulesHint')}</p>
      <ul className={styles.rules}>
        {BACKEND_GUARD_RULES.map((rule) => {
          const title = t(`environment.guard.rules.${rule}.title`);
          const isOn = !disabled.includes(rule);
          return (
            <li key={rule} className={styles.rule} data-on={isOn}>
              <Toggle
                size="sm"
                checked={isOn}
                aria-label={t('environment.guard.ruleToggle', { rule: title })}
                onCheckedChange={(checked) => onToggle(rule, checked)}
              />
              <div className={styles.ruleText}>
                <span className={styles.ruleTitle}>{title}</span>
                <span className={styles.sub}>{t(`environment.guard.rules.${rule}.text`)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
