import { Fragment } from 'react';
import { Text } from 'react-native';
import { styles } from './Markdown/Markdown.styles';

/** Инлайн: `код` и **жирный**. Разбор одним проходом, без вложенности. */
export function inline(text: string, keyPrefix: string) {
  const parts: React.ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) {
      parts.push(
        <Fragment key={`${keyPrefix}-t${index++}`}>{text.slice(cursor, match.index)}</Fragment>,
      );
    }
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(
        <Text key={`${keyPrefix}-c${index++}`} style={styles.inlineCode}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={`${keyPrefix}-b${index++}`} style={styles.bold}>
          {token.slice(2, -2)}
        </Text>,
      );
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) {
    parts.push(<Fragment key={`${keyPrefix}-t${index}`}>{text.slice(cursor)}</Fragment>);
  }
  return parts;
}
