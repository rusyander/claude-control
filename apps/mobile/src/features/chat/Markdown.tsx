import { Fragment } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, space } from '../../shared/config/theme';

/**
 * Разметка ответа агента. Не полный markdown и не притворяется им: на экране
 * шириной в 390 точек ценность имеют ровно три вещи — блоки кода отдельно от
 * текста, моноширинный инлайн и жирные заголовки списков. Остальное (таблицы,
 * ссылки, вложенные цитаты) на телефоне всё равно нечитаемо, а тащить ради него
 * парсер с деревом узлов — платить размером бандла за то, чем не пользуются.
 *
 * Панель в браузере рисует полный markdown (markdown-it) — это осознанная
 * разница носителей, а не отставание.
 */

interface Block {
  kind: 'text' | 'code';
  content: string;
  /** Язык из ограды ```ts — показывается подписью над блоком. */
  lang?: string;
}

/** Разбить текст на блоки кода и всё остальное. */
export function splitBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const pattern = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      blocks.push({ kind: 'text', content: source.slice(cursor, match.index) });
    }
    blocks.push({ kind: 'code', content: match[2] ?? '', lang: match[1] || undefined });
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) blocks.push({ kind: 'text', content: source.slice(cursor) });
  return blocks.filter((block) => block.content.trim().length > 0);
}

/** Инлайн: `код` и **жирный**. Разбор одним проходом, без вложенности. */
function inline(text: string, keyPrefix: string) {
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

export function Markdown({ children }: { children: string }) {
  const blocks = splitBlocks(children);
  if (blocks.length === 0) return null;

  return (
    <View style={styles.root}>
      {blocks.map((block, blockIndex) =>
        block.kind === 'code' ? (
          <View key={`b${blockIndex}`} style={styles.code}>
            {block.lang ? <Text style={styles.codeLang}>{block.lang}</Text> : null}
            <Text style={styles.codeText}>{block.content.replace(/\n+$/, '')}</Text>
          </View>
        ) : (
          <Text key={`b${blockIndex}`} style={styles.text}>
            {inline(block.content.replace(/\n{3,}/g, '\n\n').trim(), `b${blockIndex}`)}
          </Text>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.sm },
  text: { color: colors.text, fontSize: font.body, lineHeight: 21 },
  bold: { fontWeight: '700' },
  inlineCode: {
    fontFamily: font.mono,
    fontSize: font.small,
    color: colors.accent,
  },
  code: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: space.sm,
    gap: space.xs,
  },
  codeLang: { color: colors.textFaint, fontSize: 10, textTransform: 'uppercase' },
  codeText: { color: colors.text, fontFamily: font.mono, fontSize: font.small, lineHeight: 18 },
});
