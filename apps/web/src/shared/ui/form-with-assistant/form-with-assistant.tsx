import { AssistantChat } from '@shared/ui/assistant-chat';
import styles from './form-with-assistant.module.scss';
import type { FormWithAssistantProps } from './form-with-assistant.types';

/**
 * Раскладка формы с помощником: поля слева, чат справа. Вынесено отдельно,
 * потому что повторяется во всех редакторах — правила, скиллы, хуки,
 * серверы, права, переменные, группы.
 */
export function FormWithAssistant({
  children,
  kind,
  fields,
  schema,
  onApply,
  placeholder,
}: FormWithAssistantProps) {
  return (
    <div className={styles.root}>
      <div className={styles.fields}>{children}</div>

      <div className={styles.assistant}>
        <AssistantChat
          kind={kind}
          fields={fields}
          schema={schema}
          onApply={onApply}
          placeholder={placeholder}
        />
      </div>
    </div>
  );
}
