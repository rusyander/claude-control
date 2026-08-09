import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MessageUsage } from '@claude-control/contracts';
import { colors, font, radius, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import { compact, type CostUnit } from '../../shared/lib/format';

/**
 * Расход токенов на один шаг агента — тот же смысл, что в панели.
 *
 * Зачем два числа. Полная сумма почти на каждом шаге равна размеру контекста и
 * состоит в основном из чтения кэша — по ней дешёвый `Read` не отличить от
 * тяжёлой генерации. Поэтому рядом с общим объёмом (приглушённо) идёт объём
 * НОВОЙ работы (акцентом): свежий вход, запись в кэш и сгенерированное.
 *
 * Разбивка раскрывается нажатием, а не наведением: наведения на телефоне нет, и
 * подсказка «по hover» здесь была бы просто недоступной.
 */
export function TokenBadge({
  usage,
  unit = 'tokens',
  sharedWith,
  label,
}: {
  usage: MessageUsage;
  unit?: CostUnit;
  /** Сколько вызовов разделили этот расход — говорим об этом в разбивке. */
  sharedWith?: number;
  label?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
  // Новое — всё, кроме чтения кэша: только оно и есть работа этого шага.
  const fresh = usage.input + usage.output + usage.cacheCreation;

  const rows = [
    { key: 'input', name: t.chat.usage.input, value: usage.input, tone: styles.dotInput },
    {
      key: 'cacheCreation',
      name: t.chat.usage.cacheCreation,
      value: usage.cacheCreation,
      tone: styles.dotWrite,
    },
    {
      key: 'cacheRead',
      name: t.chat.usage.cacheRead,
      value: usage.cacheRead,
      tone: styles.dotRead,
    },
    { key: 'output', name: t.chat.usage.output, value: usage.output, tone: styles.dotOutput },
  ];

  return (
    <View style={styles.root}>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={t.chat.usage.title}
        style={({ pressed }) => [styles.badge, pressed && styles.pressed]}
      >
        {unit === 'money' && usage.costUsd !== undefined ? (
          <Text style={styles.fresh}>${usage.costUsd.toFixed(3)}</Text>
        ) : (
          <>
            <Text style={styles.total}>{compact(total)}</Text>
            <Text style={styles.fresh}>+{compact(fresh)}</Text>
          </>
        )}
      </Pressable>

      {open ? (
        <View style={styles.panel}>
          <View style={styles.head}>
            <Text style={styles.title}>{label ?? t.chat.usage.title}</Text>
            {usage.model ? (
              <Text style={styles.model} numberOfLines={1}>
                {usage.model}
              </Text>
            ) : null}
          </View>

          {/* Пропорция видов: доли читаются быстрее, чем четыре числа подряд. */}
          <View style={styles.bar}>
            {rows.map((row) =>
              row.value > 0 ? (
                <View
                  key={row.key}
                  style={[row.tone, styles.barPart, { flexGrow: row.value / Math.max(total, 1) }]}
                />
              ) : null,
            )}
          </View>

          {rows.map((row) => (
            <View key={row.key} style={styles.row}>
              <View style={[styles.dot, row.tone]} />
              <Text style={styles.rowName}>{row.name}</Text>
              <Text style={styles.rowValue}>{compact(row.value)}</Text>
              <Text style={styles.share}>
                {total > 0 ? Math.round((row.value / total) * 100) : 0}%
              </Text>
            </View>
          ))}

          <View style={styles.foot}>
            <View style={styles.row}>
              <Text style={styles.rowName}>{t.chat.usage.total}</Text>
              <Text style={styles.rowValue}>{compact(total)}</Text>
            </View>
            {usage.costUsd !== undefined ? (
              <View style={styles.row}>
                <Text style={styles.rowName}>{t.chat.usage.cost}</Text>
                <Text style={styles.rowValue}>${usage.costUsd.toFixed(4)}</Text>
              </View>
            ) : null}
          </View>

          {sharedWith !== undefined && sharedWith > 1 ? (
            <Text style={styles.note}>{t.chat.usage.shared(sharedWith)}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignSelf: 'flex-end', gap: space.xs },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  pressed: { opacity: 0.7 },
  total: { color: colors.textFaint, fontSize: font.small, fontFamily: font.mono },
  fresh: { color: colors.accent, fontSize: font.small, fontFamily: font.mono, fontWeight: '700' },
  panel: {
    minWidth: 240,
    gap: space.xs,
    padding: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { color: colors.text, fontSize: font.small, fontWeight: '700', flex: 1 },
  model: { color: colors.textFaint, fontSize: font.small, fontFamily: font.mono, flexShrink: 1 },
  bar: { flexDirection: 'row', height: 4, borderRadius: 2, overflow: 'hidden', gap: 1 },
  barPart: { flexBasis: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotInput: { backgroundColor: colors.accent },
  dotWrite: { backgroundColor: colors.warning },
  dotRead: { backgroundColor: colors.border },
  dotOutput: { backgroundColor: colors.success },
  rowName: { color: colors.textDim, fontSize: font.small, flex: 1 },
  rowValue: { color: colors.text, fontSize: font.small, fontFamily: font.mono },
  share: { color: colors.textFaint, fontSize: font.small, width: 34, textAlign: 'right' },
  foot: {
    gap: space.xs,
    paddingTop: space.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  note: { color: colors.textFaint, fontSize: font.small },
});
