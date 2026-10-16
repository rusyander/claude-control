import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { DailyUsage, HourlyActivity } from '@agentdeck/contracts';
import { Icon, Muted, Row } from '../../../shared/ui';
import { colors, space } from '../../../shared/config/theme';
import { useT } from '../../../shared/config/i18n';
import { compact } from '../../../shared/lib/format';
import { styles } from './ReportParts.styles';

/** Кнопка даты в ряду диапазона: значок календаря и выбранный день. */
export function DateButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.date, active && styles.dateOn, pressed && styles.pressed]}
    >
      <Icon
        ios="calendar"
        android="calendar_today"
        size={16}
        color={active ? colors.accent : colors.textFaint}
      />
      <Text style={[styles.dateText, active && styles.dateTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Muted>{label}</Muted>
    </View>
  );
}

/**
 * Строка разреза с полоской доли: имя, цифра и цена, а под ними — какая это
 * часть целого. Без полоски список «3.3G / 436M / 13M» приходилось сравнивать
 * в уме; длина читается сразу.
 */
export function ShareLine({
  name,
  figure,
  cost,
  share,
}: {
  name: string;
  figure: string;
  cost?: string;
  /** 0…1 — доля от самого большого в списке. */
  share: number;
}) {
  return (
    <View style={styles.share}>
      <Row gap={space.sm}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.figure}>{figure}</Text>
        {cost ? <Text style={[styles.figure, styles.cost]}>{cost}</Text> : null}
      </Row>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.max(2, Math.round(share * 100))}%` }]} />
      </View>
    </View>
  );
}

/**
 * Расход по дням столбиками. Нажатие на столбик показывает его день целиком —
 * токены и цену: подписать каждый столбик цифрой на ширине телефона нельзя.
 */
export function DayChart({ days }: { days: readonly DailyUsage[] }) {
  const t = useT();
  const shown = days.slice(-14);
  const [picked, setPicked] = useState<string | undefined>();
  const max = Math.max(1, ...shown.map((day) => day.totals.total));
  const day = shown.find((item) => item.date === picked) ?? shown[shown.length - 1];
  return (
    <>
      {day ? (
        <Row gap={space.sm}>
          <Text style={styles.dayDate}>{day.date}</Text>
          <Text style={styles.dayFigure}>
            {compact(day.totals.total)} {t.analytics.tokensShort}
          </Text>
          <Text style={[styles.dayFigure, styles.cost]}>${day.estimatedCost.toFixed(2)}</Text>
        </Row>
      ) : null}
      <View style={styles.bars}>
        {shown.map((item) => {
          const on = item.date === day?.date;
          return (
            <Pressable
              key={item.date}
              accessibilityRole="button"
              accessibilityLabel={item.date}
              onPress={() => setPicked(item.date)}
              style={styles.barSlot}
            >
              <View
                style={[
                  styles.bar,
                  on && styles.barOn,
                  { height: Math.max(2, (item.totals.total / max) * 90) },
                ]}
              />
              <Text style={[styles.barLabel, on && styles.barLabelOn]}>{item.date.slice(8)}</Text>
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

/** Активность по часам суток: когда человек работает с агентами чаще всего. */
export function HourChart({ hours }: { hours: readonly HourlyActivity[] }) {
  const byHour = Array.from({ length: 24 }, (_, hour) => hours.find((h) => h.hour === hour));
  const max = Math.max(1, ...hours.map((hour) => hour.requests));
  return (
    <View>
      <View style={styles.hours}>
        {byHour.map((hour, index) => (
          <View key={index} style={styles.hourSlot}>
            <View
              style={[
                styles.hourBar,
                { height: Math.max(2, ((hour?.requests ?? 0) / max) * 48) },
                (hour?.requests ?? 0) === 0 && styles.hourBarEmpty,
              ]}
            />
          </View>
        ))}
      </View>
      <View style={styles.hourLabels}>
        {['0', '6', '12', '18', '23'].map((label) => (
          <Text key={label} style={styles.barLabel}>
            {label}
          </Text>
        ))}
      </View>
    </View>
  );
}
