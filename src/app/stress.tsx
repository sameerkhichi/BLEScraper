import { router } from 'expo-router';
import { useMemo } from 'react';

import { MonthHistory, type HistoryCell } from '../components/monthHistory';
import { colors } from '../components/ui';
import { stressBand, stressHistoryDays, type StressBand } from '../model';
import { useAppState } from '../state/AppProvider';

const bandColor: Record<StressBand, string> = {
  Relaxed: colors.ok,
  Low: '#8fd18a',
  Moderate: '#f0c36a',
  High: colors.danger,
};

export default function StressHistoryScreen() {
  const { lastPayload } = useAppState();
  const days = useMemo<HistoryCell[]>(() => {
    return stressHistoryDays(lastPayload?.stress ?? [], lastPayload?.sleep ?? []).map((day) => ({
      key: day.key,
      primary: `${day.average}`,
      secondary: `${day.peak}–${day.minimum}`,
      color: bandColor[stressBand(day.average)],
      detail: `average ${day.average}, peak ${day.peak}, minimum ${day.minimum}`,
    }));
  }, [lastPayload?.sleep, lastPayload?.stress]);

  return (
    <MonthHistory
      days={days}
      emptyMessage="No daytime stress saved for this month."
      intro="Each day shows the daytime average, then the peak and the minimum. Days the phone never stored stay empty."
      onOpenDay={(key) => router.push({ pathname: '/stress-day', params: { day: key } })}
    />
  );
}
