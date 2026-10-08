import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { StreamedTool } from '../../../shared/lib/runs';
import { TokenBadge } from '../TokenBadge/TokenBadge';
import { summarizeToolInput } from '../toolSummary';
import { autoPickText } from '../autoPickText';
import { useT } from '../../../shared/config/i18n';
import type { CostUnit } from '../../../shared/lib/formatSpend';
import { pretty } from '../pretty';
import { styles } from './ToolCall.styles';

/**
 * Вызов инструмента в ленте. Свёрнут по умолчанию: за один ход агент делает
 * десятки вызовов, и развёрнутые они превращают экран в простыню, где ответа
 * уже не найти. Первая строка входа — тот минимум, по которому видно, что
 * происходит: путь файла, команда, запрос поиска.
 */
export function ToolCall({ tool, costUnit }: { tool: StreamedTool; costUnit: CostUnit }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const summary = summarizeToolInput(tool.input);

  // Вопрос закрыла автономия чата — строка выбора вместо вызова.
  if (tool.autoPicks !== undefined) {
    return (
      <Text style={styles.summary} testID="auto-pick">
        {autoPickText(tool.autoPicks, t)}
      </Text>
    );
  }

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
