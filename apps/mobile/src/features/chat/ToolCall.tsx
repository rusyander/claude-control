import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, space } from '../../shared/config/theme';
import type { StreamedTool } from '../../shared/lib/runs';
import type { CostUnit } from '../../shared/lib/format';
import { TokenBadge } from './TokenBadge';
import { summarizeToolInput } from './toolSummary';

/**
 * Вызов инструмента в ленте. Свёрнут по умолчанию: за один ход агент делает
 * десятки вызовов, и развёрнутые они превращают экран в простыню, где ответа
 * уже не найти. Первая строка входа — тот минимум, по которому видно, что
 * происходит: путь файла, команда, запрос поиска.
 */
export function ToolCall({ tool, costUnit }: { tool: StreamedTool; costUnit: CostUnit }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeToolInput(tool.input);

  return (
    <View style={styles.root}>
      <Pressable onPress={() => setOpen((value) => !value)} style={styles.head}>
        <Text style={styles.name}>{tool.name}</Text>
        {summary ? (
          <Text style={styles.summary} numberOfLines={1}>
            {summary}
          </Text>
        ) : null}
      </Pressable>
      {open ? <Text style={styles.body}>{pretty(tool.input)}</Text> : null}
      {/* Расход этого вызова — рядом с ним самим, а не общей суммой под ходом:
          так видно, какое именно действие оказалось дорогим. */}
      {tool.usage ? <TokenBadge usage={tool.usage} unit={costUnit} label={tool.name} /> : null}
    </View>
  );
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs + 2,
    gap: space.xs,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { color: colors.accent, fontSize: font.small, fontWeight: '700' },
  summary: { color: colors.textDim, fontSize: font.small, flex: 1, fontFamily: font.mono },
  body: { color: colors.textDim, fontSize: font.small, fontFamily: font.mono, lineHeight: 17 },
});
