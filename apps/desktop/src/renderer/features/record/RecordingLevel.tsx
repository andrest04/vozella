import { useEffect, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Meter } from '../../ui';

/**
 * The level of the take being recorded, 96 px wide, on the same dB scale as every other meter:
 * the audio worker applies `toMeterPercent` to both the idle preview and the recording level.
 * It is zero while paused and when the take ends.
 *
 * The capture engine meters the microphone only, so this is the microphone level and is
 * named that way. The session bar mounts it only when the take records a microphone.
 */
export function RecordingLevel({ paused }: { readonly paused: boolean }) {
  const t = useT();
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const off = window.vozella.on('audio.recording.level', (payload) => {
      setLevel(Math.min(100, Math.max(0, payload.level)));
    });
    return () => {
      off();
      setLevel(0);
    };
  }, []);

  return (
    <Meter value={paused ? 0 : level} label={t('Ui_RecordingLevel')} className="w-24 shrink-0" />
  );
}
