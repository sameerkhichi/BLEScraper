import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRingServices } from '../ble/ringServices';
import { Button, Card, colors } from '../components/ui';
import type { ProcessedWindow, UploadMode } from '../model';
import { useAppState } from '../state/AppProvider';

function parseWhen(dateText: string, timeText: string, blankTime: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText.trim());
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeText.trim() || blankTime);
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hour ||
    parsed.getMinutes() !== minute
  ) {
    return null;
  }
  return parsed;
}

function formatWhen(date: Date): string {
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function removedLine(removedSamples: number, removedNights: number): string {
  if (removedSamples === 0 && removedNights === 0) return 'Nothing saved in that range.';
  const samples = `${removedSamples} sample${removedSamples === 1 ? '' : 's'}`;
  const nights = `${removedNights} sleep night${removedNights === 1 ? '' : 's'}`;
  return `Removed ${samples} and ${nights}.`;
}

export default function ConfigScreen() {
  const ringServices = useRingServices();
  const { busy, settings, queue, lastPayload, sync, sendPending, forgetRing, deleteStoredRange, saveAppSettings } = useAppState();
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const waiting = queue.length > 0;
  const ringLabel = settings.ringName || settings.ringId || 'No ring selected';
  const apiLabel = settings.apiUrl.trim() || 'No API URL yet';

  const syncRing = () => {
    if (!settings.ringId) {
      router.push('/scan');
      return;
    }
    void sync();
  };

  const edit = (set: (value: string) => void) => (value: string) => {
    setNotice(null);
    set(value);
  };

  const askDelete = () => {
    const start = parseWhen(startDate, startTime, '00:00');
    const end = parseWhen(endDate, endTime, '23:59');
    if (!start || !end) {
      setNotice('Enter a start and end as YYYY-MM-DD and HH:mm.');
      return;
    }
    if (start.getTime() > end.getTime()) {
      setNotice('Start has to be before the end.');
      return;
    }
    if (!lastPayload) {
      setNotice('Nothing is saved on the phone yet.');
      return;
    }
    setNotice(null);
    Alert.alert(
      'Delete saved history?',
      `Heart rate, steps, stress, HRV, blood oxygen, temperature, and sleep from ${formatWhen(start)} to ${formatWhen(end)} will be removed. Readings waiting to send stay.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void deleteStoredRange(start, end).then((result) => {
              setNotice(removedLine(result.removedSamples, result.removedNights));
            });
          },
        },
      ],
    );
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, waiting ? { paddingBottom: 96 + insets.bottom } : null]}
        style={styles.screen}
      >
        <Card>
          <Text style={styles.label}>Ring</Text>
          <Text style={styles.body}>{ringLabel}</Text>
          {settings.ringId ? (
            <Text selectable style={styles.meta}>
              {settings.ringId}
            </Text>
          ) : null}
          <Text style={styles.meta}>
            {lastPayload?.battery
              ? `Battery ${lastPayload.battery.level}%${lastPayload.battery.charging ? ', charging' : ''}`
              : 'Battery shows up after a sync.'}
          </Text>
          <Button label="Choose ring" onPress={() => router.push('/scan')} tone="secondary" />
          {settings.ringId ? (
            <Button label="Disconnect ring" onPress={() => void forgetRing()} tone="danger" />
          ) : null}
          <Button disabled={busy} label="Sync ring" onPress={syncRing} />
          {ringServices.length > 0 ? (
            <Text selectable style={styles.services}>
              {ringServices.join('\n')}
            </Text>
          ) : null}
        </Card>

        <Card>
          <Text style={styles.label}>Arduino</Text>
          <Text selectable style={styles.body}>
            {apiLabel}
          </Text>
          <Text style={styles.meta}>
            {queue.length === 0 ? 'Nothing waiting to send.' : `${queue.length} reading${queue.length === 1 ? '' : 's'} waiting.`}
          </Text>
          <Text style={styles.meta}>Send</Text>
          <ChoiceRow
            onChange={(uploadMode) => void saveAppSettings({ ...settings, uploadMode })}
            options={[
              { value: 'raw', label: 'Raw' },
              { value: 'processed', label: 'Processed' },
              { value: 'both', label: 'Both' },
            ]}
            value={settings.uploadMode}
          />
          <Text style={styles.meta}>
            {settings.uploadMode === 'raw'
              ? 'Raw sends the sample JSON the phone already posts.'
              : settings.uploadMode === 'processed'
                ? 'Processed sends averages, scores, and debts for the window below.'
                : 'Both sends the sample JSON plus averages, scores, and debts.'}
          </Text>
          {settings.uploadMode === 'raw' ? null : (
            <>
              <Text style={styles.meta}>Processed window</Text>
              <ChoiceRow
                onChange={(processedWindow) => void saveAppSettings({ ...settings, processedWindow })}
                options={[
                  { value: 'day', label: 'Today' },
                  { value: 'week', label: 'This week' },
                  { value: 'all', label: 'All' },
                ]}
                value={settings.processedWindow}
              />
            </>
          )}
          <Button label="View waiting readings" onPress={() => router.push('/queue')} tone="secondary" />
          <Button label="API settings" onPress={() => router.push('/settings')} tone="secondary" />
        </Card>

        {waiting ? null : (
          <Button disabled label="Send waiting readings" onPress={() => void sendPending()} tone="secondary" />
        )}

        <Card>
          <Text style={styles.label}>Saved history</Text>
          <Text style={styles.meta}>
            Removes saved heart rate, steps, stress, HRV, blood oxygen, temperature, and sleep in this range. Readings
            waiting to send stay on the phone.
          </Text>
          <Text style={styles.label}>Start</Text>
          <View style={styles.row}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={edit(setStartDate)}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.date]}
              value={startDate}
            />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={edit(setStartTime)}
              placeholder="00:00"
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.time]}
              value={startTime}
            />
          </View>
          <Text style={styles.label}>End</Text>
          <View style={styles.row}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={edit(setEndDate)}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.date]}
              value={endDate}
            />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={edit(setEndTime)}
              placeholder="23:59"
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.time]}
              value={endTime}
            />
          </View>
          {notice ? <Text style={styles.meta}>{notice}</Text> : null}
          <Button disabled={busy} label="Delete saved history" onPress={askDelete} tone="danger" />
          <Text style={styles.meta}>
            Dates are YYYY-MM-DD and times are HH:mm, in local time. A blank start time means 00:00. A blank end time
            means 23:59.
          </Text>
        </Card>
      </ScrollView>

      {waiting ? (
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Button disabled={busy} label="Send waiting readings" onPress={() => void sendPending()} tone="secondary" />
        </View>
      ) : null}
    </View>
  );
}

function ChoiceRow<T extends UploadMode | ProcessedWindow>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.choices}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.choice, selected && styles.choiceSelected]}
          >
            <Text style={[styles.choiceLabel, selected && styles.choiceLabelSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.bg,
    flex: 1,
  },
  content: {
    gap: 14,
    padding: 20,
    paddingBottom: 40,
  },
  footer: {
    backgroundColor: colors.bg,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    position: 'absolute',
    right: 0,
  },
  label: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  body: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 22,
  },
  meta: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
  },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  date: {
    flex: 1.4,
  },
  time: {
    flex: 1,
  },
  services: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 15,
  },
  choices: {
    flexDirection: 'row',
    gap: 8,
  },
  choice: {
    alignItems: 'center',
    borderColor: colors.line,
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  choiceSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  choiceLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  choiceLabelSelected: {
    color: colors.accentText,
  },
});
