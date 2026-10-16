import { useState } from 'react';
import { Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import type { Analytics } from '@agentdeck/contracts';
import {
  Card,
  Chips,
  Empty,
  Loading,
  Mono,
  Muted,
  Row,
  Screen,
  Segmented,
  Title,
} from '../../src/shared/ui';
import { colors, font, space, tabular } from '../../src/shared/config/theme';
import { usePullRefresh } from '../../src/shared/lib/pull-refresh';
import { useT, type Dictionary } from '../../src/shared/config/i18n';
import { compact } from '../../src/shared/lib/format';
import { useConnection, isConfigured } from '../../src/shared/api/connection';
import { DEFAULT_PERIOD, useAnalytics } from '../../src/entities/analytics/api';
import { useProviders } from '../../src/entities/provider-chat/api';
import { analyticsRefusal } from '../../src/entities/analytics/analyticsRefusal';
import type { AnalyticsPreset, AnalyticsPeriod } from '../../src/entities/analytics/api.types';
import {
  DateButton,
  DayChart,
  HourChart,
  ShareLine,
  Stat,
} from '../../src/features/analytics/ReportParts/ReportParts';

/**
 * Аналитика по транскриптам. Считает всё сервер — приложение только показывает:
 * иначе телефон и браузер расходились бы в цифрах, и доверия не заслуживал бы
 * ни один.
 *
 * Стоимость — оценка по тарифам API. Для подписки это справочная величина, а не
 * счёт: сколько осталось от лимита, локально не знает никто.
 *
 * Отчёт разложен по вкладкам: «Обзор» — итог и динамика, «Расход» — куда ушли
 * токены (модели, проекты), «Инструменты» — чем работали агенты, «Сессии» —
 * что идёт сейчас и что было последним. Одной лентой это было семь карточек
 * подряд, и до сессий приходилось листать три экрана.
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

type ReportTab = 'overview' | 'spend' | 'tools' | 'sessions';

export default function AnalyticsScreen() {
  const t = useT();
  const connection = useConnection();
  const [period, setPeriod] = useState<AnalyticsPeriod>(DEFAULT_PERIOD);
  const [picking, setPicking] = useState<'from' | 'to' | undefined>();
  const [tab, setTab] = useState<ReportTab>('overview');
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
      header={
        <>
          <Segmented<ReportTab>
            options={[
              { value: 'overview', label: t.analytics.tabOverview },
              { value: 'spend', label: t.analytics.tabSpend },
              { value: 'tools', label: t.analytics.tabTools },
              { value: 'sessions', label: t.analytics.tabSessions },
            ]}
            value={tab}
            onChange={setTab}
          />
          <Chips<AnalyticsPreset>
            scroll
            options={PRESETS.map((preset) => ({ value: preset, label: presetLabel(preset, t) }))}
            value={period.kind === 'preset' ? period.preset : undefined}
            onChange={(preset) => setPeriod({ kind: 'preset', preset })}
          />
        </>
      }
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          tintColor={colors.accent}
        />
      }
    >
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
          {tab === 'overview' ? <Overview data={data} period={period} /> : null}
          {tab === 'spend' ? <Spend data={data} /> : null}
          {tab === 'tools' ? <Tools data={data} /> : null}
          {tab === 'sessions' ? <Sessions data={data} /> : null}
          <Muted style={styles.footnote}>
            {t.analytics.scanned(data.scannedFiles, Math.round(data.scanDurationMs))}
          </Muted>
        </View>
      ) : null}
    </Screen>
  );
}

/** Итог периода, динамика по дням и активность по часам. */
function Overview({ data, period }: { data: Analytics; period: AnalyticsPeriod }) {
  const t = useT();
  return (
    <>
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
          <DayChart days={data.byDay} />
          <Muted>{t.analytics.tapDay}</Muted>
        </Card>
      ) : null}

      {data.byHour.some((hour) => hour.requests > 0) ? (
        <Card>
          <Title>{t.analytics.byHour}</Title>
          <Muted>{t.analytics.byHourHint}</Muted>
          <HourChart hours={data.byHour} />
        </Card>
      ) : null}
    </>
  );
}

/** Куда ушли токены: модели и проекты, с долей от самого крупного. */
function Spend({ data }: { data: Analytics }) {
  const t = useT();
  const topModel = Math.max(0.01, ...data.byModel.map((model) => model.estimatedCost));
  const topProject = Math.max(0.01, ...data.byProject.map((project) => project.estimatedCost));
  if (data.byModel.length === 0 && data.byProject.length === 0) {
    return <Muted>{t.analytics.nothingForFilter}</Muted>;
  }
  return (
    <>
      {data.byModel.length > 0 ? (
        <Card>
          <Title>{t.analytics.models}</Title>
          {data.byModel.map((model) => (
            <ShareLine
              key={model.model}
              name={model.model}
              figure={compact(model.totals.total)}
              cost={`$${model.estimatedCost.toFixed(2)}`}
              share={model.estimatedCost / topModel}
            />
          ))}
        </Card>
      ) : null}
      {data.byProject.length > 0 ? (
        <Card>
          <Title>{t.analytics.projects}</Title>
          {data.byProject.slice(0, 15).map((project) => (
            <ShareLine
              key={project.project}
              name={project.displayName}
              figure={compact(project.totals.total)}
              cost={`$${project.estimatedCost.toFixed(2)}`}
              share={project.estimatedCost / topProject}
            />
          ))}
        </Card>
      ) : null}
    </>
  );
}

/** Чем работали агенты: инструменты и навыки по числу вызовов. */
function Tools({ data }: { data: Analytics }) {
  const t = useT();
  if (data.topTools.length === 0 && data.topSkills.length === 0) {
    return <Muted>{t.analytics.noTools}</Muted>;
  }
  const list = (title: string, items: Analytics['topTools']) => {
    const top = Math.max(1, ...items.map((item) => item.count));
    return items.length > 0 ? (
      <Card>
        <Title>{title}</Title>
        {items.slice(0, 15).map((item) => (
          <ShareLine
            key={item.name}
            name={item.name}
            figure={compact(item.count)}
            share={item.count / top}
          />
        ))}
      </Card>
    ) : null;
  };
  return (
    <>
      {list(t.analytics.tools, data.topTools)}
      {list(t.analytics.skills, data.topSkills)}
    </>
  );
}

/** Что запущено сейчас и последние сессии периода. */
function Sessions({ data }: { data: Analytics }) {
  const t = useT();
  return (
    <>
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
          <Muted>{t.analytics.periodSessions(data.periodSessions)}</Muted>
          {data.recentSessions.slice(0, 15).map((session, index) => (
            <View
              key={session.sessionId}
              style={[styles.session, index > 0 && styles.sessionDivided]}
            >
              <Row gap={space.sm}>
                <Text style={styles.name} numberOfLines={1}>
                  {session.title || session.displayName}
                </Text>
                <Text style={styles.cost}>${session.estimatedCost.toFixed(2)}</Text>
              </Row>
              <Muted>
                {session.title ? `${session.displayName} · ` : ''}
                {session.lastActivity.slice(0, 16).replace('T', ' ')} ·{' '}
                {compact(session.totals.total)} {t.analytics.tokensShort}
                {session.gitBranch ? ` · ${session.gitBranch}` : ''}
                {session.isActive ? t.analytics.running : ''}
              </Muted>
            </View>
          ))}
        </Card>
      ) : (
        <Muted>{t.analytics.noSessions}</Muted>
      )}
    </>
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

const styles = StyleSheet.create({
  report: { gap: space.md },
  stale: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
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
  name: { color: colors.text, fontSize: font.body, flex: 1 },
  cost: { color: colors.accent, fontSize: font.small + 1, fontWeight: '600', ...tabular },
  session: { paddingVertical: space.sm, gap: 2 },
  sessionDivided: { borderTopWidth: 1, borderTopColor: colors.border },
  footnote: { textAlign: 'center' },
  failed: { color: colors.danger },
});
