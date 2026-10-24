import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import type { AskAnswer } from '../../queue.types';
import { useLanguage, useT } from '../../../../shared/config/i18n';
import { launchLines } from '../../../../entities/inbox/askSource';
import { useState } from 'react';
import { toolSummary } from '../../../../entities/inbox/toolSummary';
import { View, Text, Pressable } from 'react-native';
import { styles } from '../AskBody.styles';
import { Mono, Row, Button } from '../../../../shared/ui';
import { space } from '../../../../shared/config/theme';

export function ToolAsk({
  ask,
  disabled,
  onAnswer,
}: {
  ask: Extract<InboxAsk, { kind: 'permission' | 'branchGate' }>;
  disabled: boolean;
  onAnswer: (answer: AskAnswer) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const lang = useLanguage();
  const summary = toolSummary(ask.input);
  const gate = ask.kind === 'branchGate';
  // Запуск агента: решают по тому, что поручено и чем, а не по сырому вызову.
  const launch = ask.kind === 'permission' ? launchLines(ask.launch, lang) : undefined;
  return (
    <View style={styles.body}>
      <Text style={styles.kind}>{gate ? t.home.branchGate : t.home.permission}</Text>
      {gate ? <Text style={styles.hint}>{t.home.branchGateHint}</Text> : null}
      <Mono style={styles.tool}>{ask.toolName}</Mono>
      {launch ? (
        <View style={styles.body}>
          <Text style={styles.hint}>{launch.title}</Text>
          {launch.description ? <Text style={styles.question}>{launch.description}</Text> : null}
          {launch.how ? <Mono style={styles.summary}>{launch.how}</Mono> : null}
        </View>
      ) : null}
      {summary && !launch?.description ? (
        <Mono style={styles.summary} numberOfLines={open ? undefined : 3}>
          {summary}
        </Mono>
      ) : null}
      <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} hitSlop={6}>
        <Text style={styles.link}>{open ? t.home.hideDetails : t.home.details}</Text>
      </Pressable>
      {open ? <Mono numberOfLines={24}>{JSON.stringify(ask.input, null, 2)}</Mono> : null}
      <Row gap={space.sm}>
        <Button
          title={gate ? t.home.writeHere : t.home.allow}
          tone="accent"
          disabled={disabled}
          style={styles.grow}
          onPress={() =>
            onAnswer(
              gate
                ? { kind: 'branchGate', choice: 'here' }
                : { kind: 'permission', behavior: 'allow' },
            )
          }
        />
        <Button
          title={gate ? t.home.dontWrite : t.home.deny}
          tone="danger"
          disabled={disabled}
          style={styles.grow}
          onPress={() =>
            onAnswer(
              gate
                ? { kind: 'branchGate', choice: 'stop' }
                : { kind: 'permission', behavior: 'deny' },
            )
          }
        />
      </Row>
    </View>
  );
}
