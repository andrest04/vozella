import { describe, expect, it } from 'vitest';
import { meetingAppSchema, meetingPromptReady, meetingPromptShow } from './index';

describe('meeting prompt contracts', () => {
  it('names the detected app on show', () => {
    expect(meetingPromptShow.payload.parse({ app: 'teams' })).toEqual({ app: 'teams' });
  });

  it('keeps show valid without an app, for the generic copy', () => {
    expect(meetingPromptShow.payload.parse({})).toEqual({});
  });

  it('rejects an app it does not know and any extra key', () => {
    expect(meetingPromptShow.payload.safeParse({ app: 'webex' }).success).toBe(false);
    expect(meetingPromptShow.payload.safeParse({ app: 'zoom', title: 'x' }).success).toBe(false);
  });

  it('lists the apps the prompt can name, plus unknown', () => {
    expect(meetingAppSchema.options).toEqual(['teams', 'zoom', 'meet', 'unknown']);
  });

  it('tells a page that just started which app is showing', () => {
    expect(meetingPromptReady.output.parse({ shown: true, app: 'meet' })).toEqual({
      shown: true,
      app: 'meet',
    });
    expect(meetingPromptReady.output.parse({ shown: false })).toEqual({ shown: false });
  });
});
