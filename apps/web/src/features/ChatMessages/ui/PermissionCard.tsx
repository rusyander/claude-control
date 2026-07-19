import { useTranslation } from 'react-i18next';
import { Icon } from '@shared/ui/icon';
import { Button } from '@shared/ui/button';
import styles from './ChatMessages.module.scss';

/**
 * Запрос агента на разрешение инструмента. Работа стоит, пока человек не решит:
 * поэтому карточка заметная, а решение — в один клик прямо в чате, без перехода
 * в терминал. Показываем, что именно агент хочет сделать (команду, файл, адрес).
 */

interface PendingPermission {
  toolName: string;
  input: unknown;
  toolUseId: string;
}

/** Короткая суть запроса: команда/файл/адрес, иначе — компактный JSON. */
function summarize(input: unknown): string {
  const object = (input ?? {}) as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const value = object[key];
    if (typeof value === 'string' && value) return value;
  }
  try {
    const json = JSON.stringify(object);
    return json.length > 240 ? `${json.slice(0, 240)}…` : json;
  } catch {
    return '';
  }
}

interface PermissionCardProps {
  permissions: PendingPermission[];
  onDecide: (toolUseId: string, behavior: 'allow' | 'deny') => void;
}

export function PermissionCard({ permissions, onDecide }: PermissionCardProps) {
  const { t } = useTranslation();
  if (permissions.length === 0) return null;

  return (
    <div className={`${styles.question} ${styles.permission}`}>
      <div className={`${styles.questionHead} ${styles.permissionHead}`}>
        <Icon name="permissions" size={20} />
        <span>{t('chat.permissionTitle')}</span>
      </div>

      {permissions.map((permission) => (
        <div key={permission.toolUseId} className={styles.questionItem}>
          <span className={styles.questionBadge}>{permission.toolName}</span>
          <pre className={styles.permissionInput}>{summarize(permission.input)}</pre>
          <div className={styles.permissionActions}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onDecide(permission.toolUseId, 'deny')}
            >
              {t('chat.deny')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => onDecide(permission.toolUseId, 'allow')}
            >
              {t('chat.allow')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
