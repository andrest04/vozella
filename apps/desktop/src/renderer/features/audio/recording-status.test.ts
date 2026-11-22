import { describe, expect, it } from 'vitest';
import { recordingStatus, sourcesSummaryArgs, startFailureMessage } from './recording-status';

describe('recordingStatus', () => {
  it('names the four mic and output combinations', () => {
    expect(recordingStatus({ microphone: true, appName: null })).toEqual({
      key: 'Status_Recording',
      args: [],
    });
    expect(recordingStatus({ microphone: false, appName: null })).toEqual({
      key: 'Status_RecordingNoMic',
      args: [],
    });
    expect(recordingStatus({ microphone: true, appName: 'Zoom' })).toEqual({
      key: 'Status_RecordingMicApp',
      args: ['Zoom'],
    });
    expect(recordingStatus({ microphone: false, appName: 'Zoom' })).toEqual({
      key: 'Status_RecordingNoMicApp',
      args: ['Zoom'],
    });
  });
});

describe('sourcesSummaryArgs', () => {
  const labels = { systemDefault: 'System default', allSystem: 'All system audio' };
  it('falls back to the system default and all system audio', () => {
    expect(sourcesSummaryArgs(null, null, labels)).toEqual(['System default', 'All system audio']);
  });
  it('uses the selected names', () => {
    expect(sourcesSummaryArgs('Test headset', 'Zoom', labels)).toEqual(['Test headset', 'Zoom']);
  });
});

describe('startFailureMessage', () => {
  it('speaks plainly when one app cannot be captured on this Windows', () => {
    expect(startFailureMessage('process-loopback-unsupported', 'build 19041')).toEqual({
      key: 'Ui_ProcessLoopbackUnsupported',
      args: [],
    });
  });
  it('wraps any other start failure with its message', () => {
    expect(startFailureMessage(undefined, 'device busy')).toEqual({
      key: 'Error_StartRecording',
      args: ['device busy'],
    });
  });
});
