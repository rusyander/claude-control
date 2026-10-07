import { AssistantChat } from '@shared/ui/assistant-chat';
import {
  assistantSchema,
  readAssistantFields,
  type AssistantApplyReport,
  type AssistantSpec,
} from '@shared/lib/assistant-fields';
import styles from './form-with-assistant.module.scss';
import type { FormWithAssistantProps } from './form-with-assistant.types';

/**
 * Раскладка формы с помощником: поля слева, чат справа. Вынесено отдельно,
 * потому что повторяется во всех редакторах — правила, скиллы, хуки,
 * серверы, права, переменные, группы.
 *
 * Ответ модели проверяется здесь по описанию полей: форма получает только
 * годные значения, а отброшенное (несуществующий id, не тот вид) лента
 * помощника называет под ответом.
 */
export function FormWithAssistant<const S extends AssistantSpec>({
  children,
  kind,
  fields,
  spec,
  onApply,
  placeholder,
  loading,
}: FormWithAssistantProps<S>) {
  const apply = (raw: Record<string, unknown>): AssistantApplyReport => {
    const reading = readAssistantFields(spec, raw);
    if (reading.applied.length > 0) onApply(reading.values);
    return { applied: reading.applied, missed: reading.missed };
  };

  return (
    <div className={styles.root}>
      <div className={styles.fields}>{children}</div>

      <div className={styles.assistant}>
        <AssistantChat
          kind={kind}
          fields={fields}
          schema={assistantSchema(spec)}
          onApply={apply}
          placeholder={placeholder}
          loading={loading}
        />
      </div>
    </div>
  );
}
