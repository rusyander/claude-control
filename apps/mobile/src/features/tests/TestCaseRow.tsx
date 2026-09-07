import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ProjectTestCase } from '@agentdeck/contracts';
import { stepText, toSteps } from '@agentdeck/contracts/test-format';
import { Muted, Row } from '../../shared/ui';
import { colors, font, radius, space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import { STATUS_MARK, formatWhen, statusColor } from '../../entities/tests/status';

/**
 * Строка списка кейсов: свёрнутая — статус, название и метки; раскрытая — всё
 * остальное, включая ожидание КАЖДОГО шага.
 *
 * Атрибуты кейса (тип, важность, метки, зона) вынесены в свёрнутый вид
 * намеренно: по ним отбирают, а отбор без видимых значений превращается в
 * угадывание — человек не понимает, почему кейс попал под фильтр.
 */
export function TestCaseRow({
  testCase,
  isSelected,
  onToggleSelected,
  onEdit,
  onRemove,
}: {
  testCase: ProjectTestCase;
  isSelected: boolean;
  onToggleSelected: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [isOpen, setOpen] = useState(false);
  const steps = toSteps(testCase.steps);

  return (
    <View style={[styles.case, testCase.status === 'failed' && styles.caseFailed]}>
      <Row gap={space.xs}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: isSelected }}
          onPress={onToggleSelected}
          hitSlop={8}
        >
          <Text style={[styles.box, isSelected && styles.boxOn]}>{isSelected ? '☑' : '☐'}</Text>
        </Pressable>
        <Pressable style={styles.grow} onPress={() => setOpen((value) => !value)}>
          <Row gap={space.xs}>
            <Text style={[styles.mark, { color: statusColor(testCase.status) }]}>
              {STATUS_MARK[testCase.status]}
            </Text>
            <Text style={styles.caseTitle} numberOfLines={isOpen ? undefined : 2}>
              {testCase.title}
            </Text>
          </Row>
          <Muted>{attributeLine(testCase, t)}</Muted>
        </Pressable>
      </Row>

      {isOpen ? (
        <View style={styles.details}>
          {testCase.purpose ? <Muted>{testCase.purpose}</Muted> : null}
          {testCase.precondition ? (
            <Muted>
              {t.tests.casePrecondition}: {testCase.precondition}
            </Muted>
          ) : null}
          {steps.map((step, index) => (
            <Text key={index} style={styles.step}>
              {index + 1}. {stepText(step)}
            </Text>
          ))}
          {testCase.expected ? <Muted>→ {testCase.expected}</Muted> : null}
          {testCase.oracle ? (
            <Muted>
              {t.tests.caseOracle}: {testCase.oracle}
            </Muted>
          ) : null}
          {testCase.muted && testCase.muteReason ? (
            <Muted>{t.tests.muteReason(testCase.muteReason)}</Muted>
          ) : null}
          {testCase.note ? (
            <Text style={testCase.status === 'failed' ? styles.bad : styles.note}>
              {testCase.note}
            </Text>
          ) : null}
          <Muted>
            {testCase.lastRunAt
              ? t.tests.lastRun(formatWhen(testCase.lastRunAt))
              : t.tests.lastRunNever}
          </Muted>
          <Muted>
            {testCase.id} · {t.tests.status[testCase.status]} · {t.tests.source[testCase.source]}
          </Muted>
          <Row gap={space.sm}>
            <Pressable onPress={onEdit}>
              <Text style={styles.action}>{t.tests.editCase}</Text>
            </Pressable>
            <Pressable onPress={onRemove}>
              <Text style={styles.bad}>{t.tests.remove}</Text>
            </Pressable>
          </Row>
        </View>
      ) : null}
    </View>
  );
}

/** Тип, важность, зона и метки одной строкой — то, по чему идёт отбор. */
function attributeLine(testCase: ProjectTestCase, t: ReturnType<typeof useT>): string {
  const parts = [t.tests.kind[testCase.type ?? 'case']];
  // Карантин — первым после типа: он объясняет красный статус строки, и
  // прочитать его нужно раньше, чем метки.
  if (testCase.muted) parts.push(t.tests.muted);
  if (testCase.priority) parts.push(t.tests.priority[testCase.priority]);
  if (testCase.automation?.status) parts.push(t.tests.automation[testCase.automation.status]);
  if (testCase.section) parts.push(testCase.section);
  else if (testCase.area) parts.push(testCase.area);
  for (const tag of testCase.tags ?? []) parts.push(`#${tag}`);
  return parts.join(' · ');
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  case: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: space.sm,
    gap: space.xs,
  },
  caseFailed: { borderColor: colors.danger },
  caseTitle: { color: colors.text, fontSize: font.body, flex: 1 },
  mark: { fontSize: font.body, width: 18, textAlign: 'center' },
  box: { color: colors.textDim, fontSize: font.title, width: 22, textAlign: 'center' },
  boxOn: { color: colors.accent },
  details: { gap: space.xs },
  step: { color: colors.textDim, fontSize: font.small },
  note: { color: colors.textDim, fontSize: font.small },
  action: { color: colors.accent, fontSize: font.small },
  bad: { color: colors.danger, fontSize: font.small },
});
