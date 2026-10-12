import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiHistory, useClearApiHistory } from '@entities/ApiExplorer';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { ConfirmDialog } from '@shared/ui/confirm-dialog';
import { Icon } from '@shared/ui/icon';
import { statusTone } from '../../lib/apiRequest';
import type { ApiHistoryProps } from './ApiExplorer.types';
import { MethodBadge } from './MethodBadge';
import styles from './ApiExplorer.module.scss';

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Последние запросы проекта: клик — запрос снова в редакторе, как был.
 * Секреты в истории — маской, поэтому замаскированный заголовок повторно не
 * уходит: вместо него подставится сохранённая авторизация.
 */
export function ApiHistory({ projectPath, isOpen, onReplay }: ApiHistoryProps) {
  const { t } = useTranslation();
  const history = useApiHistory(projectPath, isOpen);
  const clear = useClearApiHistory(projectPath);
  const [confirming, setConfirming] = useState(false);
  const list = history.data ?? [];

  return (
    <details className={styles.history} open={list.length > 0}>
      <summary>
        <Icon name="history" size={16} />
        <span className={styles.sectionTitle}>{t('environment.api.history.label')}</span>
        {list.length > 0 && <Badge tone="neutral">{list.length}</Badge>}
      </summary>
      {list.length === 0 ? (
        <p className={styles.sub}>{t('environment.api.history.empty')}</p>
      ) : (
        <>
          <ul className={styles.historyList}>
            {list.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={styles.historyItem}
                  aria-label={t('environment.api.history.replay', {
                    method: entry.method.toUpperCase(),
                    url: entry.url,
                  })}
                  onClick={() => onReplay(entry)}
                >
                  <MethodBadge method={entry.method} />
                  <span className={styles.historyUrl}>{entry.url}</span>
                  {entry.status !== undefined ? (
                    <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>
                  ) : (
                    <Badge tone="danger">{t('environment.api.history.failed')}</Badge>
                  )}
                  {entry.verdict === 'mismatch' && (
                    <Badge tone="danger" withDot>
                      {t('environment.api.history.mismatch')}
                    </Badge>
                  )}
                  <span className={styles.sub}>{time(entry.at)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className={styles.historyBar}>
            <span className={styles.sub}>{t('environment.api.history.maskedNote')}</span>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Icon name="trash" size={16} />}
              onClick={() => setConfirming(true)}
            >
              {t('environment.api.history.clear')}
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => {
          setConfirming(false);
          clear.mutate();
        }}
        title={t('environment.api.history.clearTitle')}
        description={t('environment.api.history.clearText')}
        confirmLabel={t('environment.api.history.clear')}
      />
    </details>
  );
}
