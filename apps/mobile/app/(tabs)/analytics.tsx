import { useState } from 'react';
import { Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import type { TokenTotals } from '@agentdeck/contracts';
import {
  Card,
  Chips,
  Empty,
  Icon,
  Loading,
  Mono,
  Muted,
  Row,
  Screen,
  Title,
} from '../../src/shared/ui';
import { colors, font, radius, space, tabular } from '../../src/shared/config/theme';
import { usePullRefresh } from '../../src/shared/lib/pull-refresh';
import { useT, type Dictionary } from '../../src/shared/config/i18n';
import { compact } from '../../src/shared/lib/format';
import { useConnection, isConfigured } from '../../src/shared/api/connection';
import { DEFAULT_PERIOD, useAnalytics } from '../../src/entities/analytics/api';
import { useProviders } from '../../src/entities/provider-chat/api';
import { analyticsRefusal } from '../../src/entities/analytics/analyticsRefusal';
import type { AnalyticsPreset, AnalyticsPeriod } from '../../src/entities/analytics/api.types';

/**
 * Аналитика по транскриптам. Считает всё сервер — приложение только показывает:
 * иначе телефон и браузер расходились бы в цифрах, и доверия не заслуживал бы
 * ни один.
 *
 * Стоимость — оценка по тарифам API. Для подписки это справочная величина, а не
 * счёт: сколько осталось от лимита, локально не знает никто.
 *
 * Фильтры — те же, что в панели: пять пресетов, произвольный диапазон и сброс.
 * Диапазон выбирается системным календарём, а не двумя полями для даты: набирать
 * `2026-08-09` пальцем на телефоне никто не станет.
 *
 * Под CLI, журналы которого панель не читает (goose, kimi, gemini…), сервер
 * отвечает отказом — экран показывает его текст и НИ ОДНОЙ цифры: прежний отчёт
 * Claude, оставшийся в кэше запроса, под чужим CLI был бы ложью.
 */

const PRESETS: AnalyticsPreset[] = ['today', '7', '30', '90', '0'];

export default function AnalyticsScreen() {
  const t = useT();
  const connection = useConnection();
  const [period, setPeriod] = useState<AnalyticsPeriod>(DEFAULT_PERIOD);
  const [picking, setPicking] = useState<'from' | 'to' | undefined>();
  const providers = useProviders();
  const analytics = useAnalytics(period, providers.data?.active);
  const refusal = analyticsRefusal(analytics.error);
  // Крутилка сверху — только на жест: смена периода грузится под приглушённым
  // отчётом, а не крутилкой поверх ряда периодов.
  const pull = usePullRefresh(analytics.refetch);

  if (!isConfigured(connection)) {
    return <Empty text={t.common.notConnected} />;
  }

  const data = refusal ? undefined : analytics.data;
  const maxDay = Math.max(1, ...(data?.byDay ?? []).map((day) => day.totals.total));
  const isRange = period.kind === 'range';
  const isDefault =
    period.kind === 'preset' &&
    DEFAULT_PERIOD.kind === 'preset' &&
    period.preset === DEFAULT_PERIOD.preset;

  /**
   * Первая выбранная дата задаёт обе границы: одни сутки — законный период, а не
   * незаконченный ввод. Вторая правит ту границу, которую попросили.
   */
  const pickDate = (date: Date | undefined): void => {
    const edge = picking;
    setPicking(undefined);
    if (!date || !edge) return;
    const iso = isoDay(date);
    if (period.kind !== 'range') {
      setPeriod({ kind: 'range', from: iso, to: iso });
      return;
    }
    const next = edge === 'from' ? { from: iso, to: period.to } : { from: period.from, to: iso };
    // Границы, поставленные наоборот, меняем местами: отчёт «с 9-го по 2-е»
    // сервер вернул бы пустым, и человек решил бы, что расхода не было.
    setPeriod({
      kind: 'range',
      from: next.from <= next.to ? next.from : next.to,
      to: next.from <= next.to ? next.to : next.from,
    });
  };

  return (
    <Screen
      scroll
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          tintColor={colors.accent}
        />
      }
    >
      <Chips<AnalyticsPreset>
        scroll
        options={PRESETS.map((preset) => ({ value: preset, label: presetLabel(preset, t) }))}
        value={period.kind === 'preset' ? period.preset : undefined}
        onChange={(preset) => setPeriod({ kind: 'preset', preset })}
      />

      <Row gap={space.sm}>
        <DateButton
          label={period.kind === 'range' ? period.from : t.analytics.from}
          active={isRange}
          onPress={() => setPicking('from')}
        />
        <Text style={styles.dash}>—</Text>
        <DateButton
          label={period.kind === 'range' ? period.to : t.analytics.to}
          active={isRange}
          onPress={() => setPicking('to')}
        />
        {/* Сброс виден, только когда есть что сбрасывать: серая неактивная
            кнопка рядом с датами читалась как поломка. */}
        {isDefault ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setPeriod(DEFAULT_PERIOD)}
            style={({ pressed }) => [styles.reset, pressed && styles.pressed]}
          >
            <Text style={styles.resetText}>{t.analytics.reset}</Text>
          </Pressable>
        )}
      </Row>

      {picking ? (
        <DateTimePicker
          value={dateOf(period, picking)}
          mode="date"
          maximumDate={new Date()}
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onValueChange={(_event, date) => pickDate(date)}
          onDismiss={() => pickDate(undefined)}
        />
      ) : null}

      {analytics.isLoading && !data ? <Loading /> : null}
      {refusal ? (
        <Card>
          <Muted>{refusal}</Muted>
        </Card>
      ) : analytics.isError ? (
        <Mono style={styles.failed}>{t.common.panelSilent}</Mono>
      ) : null}

      {data ? (
        <View style={[styles.report, analytics.isPlaceholderData && styles.stale]}>
          <Card>
            <Text style={styles.hero}>${data.estimatedCost.toFixed(2)}</Text>
            {/* Выбранный диапазон показываем ровно тем, чем его выбрали: сервер
                возвращает границы мгновением в UTC, а сутки в отчёте — это
                КАЛЕНДАРНЫЕ сутки машины с панелью. Телефон в другом поясе
                подписал бы выбранное 5-е число как «с 4-го». */}
            <Muted>
              {period.kind === 'range'
                ? `${period.from} — ${period.to}`
                : `${isoDay(new Date(data.from))} — ${isoDay(new Date(data.to))}`}{' '}
              · {t.analytics.estimate}
            </Muted>
            <View style={styles.stats}>
              <Stat label={t.analytics.tokens} value={compact(data.overall.total)} />
              <Stat label={t.analytics.requests} value={compact(data.overall.requests)} />
              <Stat label={t.analytics.cached} value={`${Math.round(data.cacheHitRatio * 100)}%`} />
              <Stat label={t.analytics.activeSessions} value={String(data.activeSessions)} />
            </View>
          </Card>

          {data.overall.total === 0 ? <Muted>{t.analytics.nothingForFilter}</Muted> : null}

          {data.byDay.length > 0 ? (
            <Card>
              <Title>{t.analytics.byDay}</Title>
              <View style={styles.bars}>
                {data.byDay.slice(-14).map((day) => (
                  <View key={day.date} style={styles.barSlot}>
                    <View
                      style={[
                        styles.bar,
                        { height: Math.max(2, (day.totals.total / maxDay) * 90) },
                      ]}
                    />
                    <Text style={styles.barLabel}>{day.date.slice(8)}</Text>
                  </View>
                ))}
              </View>
            </Card>
          ) : null}

          {data.byModel.length > 0 ? (
            <Card>
              <Title>{t.analytics.models}</Title>
              {data.byModel.map((model) => (
                <Line
                  key={model.model}
                  name={model.model}
                  totals={model.totals}
                  cost={model.estimatedCost}
                />
              ))}
            </Card>
          ) : null}

          {data.byProject.length > 0 ? (
            <Card>
              <Title>{t.analytics.projects}</Title>
              {data.byProject.slice(0, 10).map((project) => (
                <Line
                  key={project.project}
                  name={project.displayName}
                  totals={project.totals}
                  cost={project.estimatedCost}
                />
              ))}
            </Card>
          ) : null}

          {data.topTools.length > 0 ? (
            <Card>
              <Title>{t.analytics.tools}</Title>
              {data.topTools.slice(0, 12).map((tool) => (
                <Tally key={tool.name} name={tool.name} count={tool.count} />
              ))}
            </Card>
          ) : null}

          {data.topSkills.length > 0 ? (
            <Card>
              <Title>{t.analytics.skills}</Title>
              {data.topSkills.slice(0, 12).map((skill) => (
                <Tally key={skill.name} name={skill.name} count={skill.count} />
              ))}
            </Card>
          ) : null}

          {data.runningAgents.length > 0 ? (
            <Card>
              <Title>{t.analytics.runningNow}</Title>
              {data.runningAgents.map((agent) => (
                <Mono key={agent.pid}>
                  {agent.name} · pid {agent.pid} · {Math.round(agent.memoryMb)} {t.analytics.mb}
                </Mono>
              ))}
            </Card>
          ) : null}

          {data.recentSessions.length > 0 ? (
            <Card>
              <Title>{t.analytics.recentSessions}</Title>
              {data.recentSessions.slice(0, 10).map((session) => (
                <View key={session.sessionId} style={styles.session}>
                  <Row gap={space.sm}>
                    <Text style={styles.name} numberOfLines={1}>
                      {session.displayName}
                    </Text>
                    <Mono>${session.estimatedCost.toFixed(2)}</Mono>
                  </Row>
                  <Muted>
                    {session.lastActivity.slice(0, 16).replace('T', ' ')} ·{' '}
                    {compact(session.totals.total)} {t.analytics.tokensShort}
                    {session.gitBranch ? ` · ${session.gitBranch}` : ''}
                    {session.isActive ? t.analytics.running : ''}
                  </Muted>
                </View>
              ))}
            </Card>
          ) : null}

          <Muted style={styles.footnote}>
            {t.analytics.scanned(data.scannedFiles, Math.round(data.scanDurationMs))}
          </Muted>
        </View>
      ) : null}
    </Screen>
  );
}

function presetLabel(preset: AnalyticsPreset, t: Dictionary): string {
  if (preset === 'today') return t.analytics.today;
  if (preset === '0') return t.analytics.all;
  return t.analytics.days(Number(preset));
}

/** Местный календарный день: `toISOString()` увёл бы дату на день по UTC. */
function isoDay(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function dateOf(period: AnalyticsPeriod, edge: 'from' | 'to'): Date {
  if (period.kind !== 'range') return new Date();
  const value = new Date(edge === 'from' ? period.from : period.to);
  return Number.isNaN(value.getTime()) ? new Date() : value;
}

function DateButton({
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Muted>{label}</Muted>
    </View>
  );
}

function Line({ name, totals, cost }: { name: string; totals: TokenTotals; cost: number }) {
  return (
    <Row gap={space.sm} style={styles.line}>
      <Text style={styles.name} numberOfLines={1}>
        {name}
      </Text>
      <Text style={styles.figure}>{compact(totals.total)}</Text>
      <Text style={[styles.figure, styles.cost]}>${cost.toFixed(2)}</Text>
    </Row>
  );
}

/**
 * Имя и счётчик строкой. Не «облаком» из имён с числами вперемешку: в потоке
 * `Bash 7361 Edit 3695` глазом не отделить, где кончилось одно и началось
 * другое, а имена инструментов бывают в полэкрана длиной.
 */
function Tally({ name, count }: { name: string; count: number }) {
  return (
    <Row gap={space.sm} style={styles.line}>
      <Text style={styles.name} numberOfLines={1}>
        {name}
      </Text>
      <Text style={styles.figure}>{compact(count)}</Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  report: { gap: space.md },
  stale: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
  date: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 40,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  dateOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  dateText: { color: colors.textDim, fontSize: font.small + 1, flexShrink: 1, ...tabular },
  dateTextOn: { color: colors.text },
  reset: { minHeight: 40, justifyContent: 'center', paddingHorizontal: space.sm },
  resetText: { color: colors.accent, fontSize: font.small + 1, fontWeight: '600' },
  dash: { color: colors.textFaint, fontSize: font.small },
  hero: { color: colors.text, fontSize: font.hero, fontWeight: '700', ...tabular },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: space.md,
    marginTop: space.sm,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  stat: { width: '50%', gap: 2 },
  statValue: { color: colors.text, fontSize: font.large, fontWeight: '700', ...tabular },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 120, marginTop: space.xs },
  barSlot: { flex: 1, alignItems: 'center', gap: space.xs },
  bar: {
    width: '100%',
    backgroundColor: colors.accent,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    borderBottomLeftRadius: 1,
    borderBottomRightRadius: 1,
  },
  barLabel: { color: colors.textFaint, fontSize: 10, ...tabular },
  line: { paddingVertical: space.xs },
  name: { color: colors.text, fontSize: font.body, flex: 1 },
  figure: { color: colors.textDim, fontSize: font.small + 1, ...tabular },
  cost: { color: colors.accent, fontWeight: '600', minWidth: 64, textAlign: 'right' },
  session: { paddingVertical: space.xs, gap: 2 },
  footnote: { textAlign: 'center' },
  failed: { color: colors.danger },
});
