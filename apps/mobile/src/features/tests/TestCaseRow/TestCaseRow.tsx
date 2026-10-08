import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ProjectTestCase } from '@agentdeck/contracts';
import { retryPassAttempts, stepText, toSteps } from '@agentdeck/contracts/test-format';
import { Muted, Row } from '../../../shared/ui';
import { space } from '../../../shared/config/theme';
import { useT, useLanguage } from '../../../shared/config/i18n';
import { STATUS_MARK, statusColor } from '../../../entities/tests/status';
import { formatWhen } from '../../../entities/tests/formatWhen';
import { attributeLine } from '../attributeLine';
import { styles } from './TestCaseRow.styles';

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
  const language = useLanguage();
  const [isOpen, setOpen] = useState(false);
  const steps = toSteps(testCase.steps);
  const retryAttempts = retryPassAttempts(testCase);

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
              {index + 1}. {stepText(step, t.tests.stepLabels)}
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
          {/* Зелёный только на повторе — числом из файла, словами из словаря. */}
          {retryAttempts !== undefined ? (
            <Text style={styles.warn}>{t.tests.retryPass(retryAttempts)}</Text>
          ) : null}
          <Muted>
            {testCase.lastRunAt
              ? t.tests.lastRun(formatWhen(testCase.lastRunAt, language))
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
