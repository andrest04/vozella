import { describe, expect, it } from 'vitest';
import {
  eventChannels,
  recordingAnswer,
  recordingAnswerSetupRequested,
  recordingOpenAnswerSetup,
  requestChannels,
} from './index';

const idle = {
  isAnswering: false,
  text: '',
  error: null,
  usedWeb: false,
  canUseWebSearch: false,
};

describe('live answer contracts', () => {
  it('types the missing provider as a reason the page can act on', () => {
    const noProvider = {
      ...idle,
      error: { key: 'Ui_LiveAnswerNoProvider', text: '', reason: 'no-provider' },
    };
    expect(recordingAnswer.payload.parse(noProvider)).toEqual(noProvider);
  });

  it('keeps the other failures without a reason and refuses an unknown one', () => {
    const failed = { ...idle, error: { key: null, text: 'The CLI failed.' } };
    expect(recordingAnswer.payload.parse(failed)).toEqual(failed);
    expect(
      recordingAnswer.payload.safeParse({
        ...idle,
        error: { key: null, text: 'x', reason: 'offline' },
      }).success,
    ).toBe(false);
  });

  it('registers the request that opens the engine setup and the event the main window follows', () => {
    expect(requestChannels['recording.openAnswerSetup']).toBe(recordingOpenAnswerSetup);
    expect(eventChannels['recording.answerSetupRequested']).toBe(recordingAnswerSetupRequested);
    expect(recordingOpenAnswerSetup.input.safeParse({}).success).toBe(true);
    expect(recordingOpenAnswerSetup.input.safeParse({ tag: 'Settings' }).success).toBe(false);
    expect(recordingOpenAnswerSetup.output.parse({ opened: true })).toEqual({ opened: true });
    expect(recordingAnswerSetupRequested.payload.parse({})).toEqual({});
  });
});
