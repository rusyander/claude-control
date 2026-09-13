import { Fragment } from 'react';
import styles from './typography.module.scss';

interface CodeTextProps {
  /** Текст словаря: фрагменты в обратных кавычках — пути, флаги, имена. */
  text: string;
}

/**
 * Строка словаря с фрагментами кода в обратных кавычках.
 *
 * Тексты о флагах CLI и файлах конфигурации без кавычек не читаются: путь
 * сливается с предложением. Выведенные как есть, кавычки стоят на экране
 * сырыми — поэтому они превращаются в `<code>`, а сама разметка в словарь не
 * пускается. Непарная кавычка остаётся текстом.
 */
export function CodeText({ text }: CodeTextProps) {
  const parts = text.split('`');
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className={styles.code}>
            {part}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}
