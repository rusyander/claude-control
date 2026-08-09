import { useState } from 'react';
import { Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import type { TokenTotals } from '@claude-control/contracts';
import { Card, Empty, Loading, Mono, Muted, Row, Screen, Title } from '../../src/shared/ui';
import { colors, font, radius, space } from '../../src/shared/config/theme';
import { useT, type Dictionary } from '../../src/shared/config/i18n';
import { compact } from '../../src/shared/lib/format';
import { isConfigured, useConnection } from '../../src/shared/api/connection';
import {
  DEFAULT_PERIOD,
  useAnalytics,
  type AnalyticsPeriod,
  type AnalyticsPreset,
} from '../../src/entities/analytics/api';

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
 */

const PRESETS: AnalyticsPreset[] = ['today', '7', '30', '90', '0'];

export default function AnalyticsScreen() {
  const t = useT();
  const connection = useConnection();
  const [period, setPeriod] = useState<AnalyticsPeriod>(DEFAULT_PERIOD);
  const [picking, setPicking] = useState<'from' | 'to' | undefined>();
  const analytics = useAnalytics(period);

  if (!isConfigured(connection)) {
    return <Empty text={t.common.notConnected} />;
  }

  const data = analytics.data;
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
          refreshing={analytics.isFetching}
          onRefresh={() => void analytics.refetch()}
          tintColor={colors.accent}
        />
      }
    >
      <Row gap={space.xs} style={styles.wrap}>
        {PRESETS.map((preset) => (
          <Pressable
            key={preset}
            onPress={() => setPeriod({ kind: 'preset', preset })}
            style={[
              styles.chip,
              !isRange && period.kind === 'preset' && period.preset === preset && styles.chipOn,
            ]}
          >
            <Text
              style={[
                styles.chipText,
                !isRange &&
                  period.kind === 'preset' &&
                  period.preset === preset &&
                  styles.chipTextOn,
              ]}
            >
              {presetLabel(preset, t)}
            </Text>
          </Pressable>
        ))}
      </Row>

      <Row gap={space.xs} style={styles.wrap}>
        <Pressable
          onPress={() => setPicking('from')}
          style={[styles.chip, isRange && styles.chipOn]}
        >
          <Text style={[styles.chipText, isRange && styles.chipTextOn]}>
            {period.kind === 'range' ? period.from : t.analytics.from}
          </Text>
        </Pressable>
        <Text style={styles.dash}>—</Text>
        <Pressable onPress={() => setPicking('to')} style={[styles.chip, isRange && styles.chipOn]}>
          <Text style={[styles.chipText, isRange && styles.chipTextOn]}>
            {period.kind === 'range' ? period.to : t.analytics.to}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setPeriod(DEFAULT_PERIOD)}
          disabled={isDefault}
          style={[styles.chip, isDefault && styles.chipOff]}
        >
          <Text style={styles.chipText}>{t.analytics.reset}</Text>
        </Pressable>
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

      {analytics.isLoading ? <Loading /> : null}
      {analytics.isError ? <Mono style={styles.failed}>{t.common.panelSilent}</Mono> : null}

      {data ? (
        <>
          <Card>
            <Title>${data.estimatedCost.toFixed(2)}</Title>
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
            <Row gap={space.md} style={styles.wrap}>
              <Stat label={t.analytics.tokens} value={compact(data.overall.total)} />
              <Stat label={t.analytics.requests} value={compact(data.overall.requests)} />
              <Stat label={t.analytics.cached} value={`${Math.round(data.cacheHitRatio * 100)}%`} />
              <Stat label={t.analytics.activeSessions} value={String(data.activeSessions)} />
            </Row>
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

          <Muted>{t.analytics.scanned(data.scannedFiles, Math.round(data.scanDurationMs))}</Muted>
        </>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View>
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
      <Mono>{compact(totals.total)}</Mono>
      <Mono style={styles.cost}>${cost.toFixed(2)}</Mono>
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
      <Mono>{compact(count)}</Mono>
    </Row>
  );
}

const styles = StyleSheet.create({
  wrap: { flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  chipOff: { opacity: 0.45 },
  chipText: { color: colors.textDim, fontSize: font.small },
  chipTextOn: { color: colors.text },
  dash: { color: colors.textFaint, fontSize: font.small },
  statValue: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 110 },
  barSlot: { flex: 1, alignItems: 'center', gap: 2 },
  bar: { width: '100%', backgroundColor: colors.accent, borderRadius: 2 },
  barLabel: { color: colors.textFaint, fontSize: 9 },
  line: { paddingVertical: 2 },
  name: { color: colors.text, fontSize: font.body, flex: 1 },
  cost: { color: colors.accent },
  session: { paddingVertical: space.xs, gap: 2 },
  failed: { color: colors.danger },
});
