import { describe, expect, it } from 'vitest';
import {
  eventChannels,
  generateOutcomeSchema,
  requestChannels,
  summariesCheckCli,
  summariesChooseCli,
  summariesChooseLocalModel,
  summariesGenerate,
  summariesHardware,
  summariesLoadTab,
  summariesProgress,
  summariesProviderStatus,
  summariesExportActionItemsIcs,
  summariesReplaceSummary,
  summariesSetActionItemDate,
  summariesSetNextSessionDate,
  summariesToggleAction,
} from './index';

describe('summaries contracts', () => {
  it('registers every request and the progress event by name', () => {
    for (const name of [
      'summaries.loadTab',
      'summaries.generate',
      'summaries.cancel',
      'summaries.saveNotes',
      'summaries.toggleAction',
      'summaries.copyActions',
      'summaries.writeClipboard',
      'summaries.setTemplate',
      'summaries.providerStatus',
      'summaries.hardware',
      'summaries.checkCli',
      'summaries.chooseLocalModel',
      'summaries.cancelLocalModel',
      'summaries.chooseCli',
    ]) {
      expect(Object.keys(requestChannels)).toContain(name);
    }
    expect(Object.keys(eventChannels)).toContain('summaries.progress');
  });

  it('every generate outcome is a value the schema accepts', () => {
    const outcomes: unknown[] = [
      {
        status: 'generated',
        title: 'T',
        titleChanged: false,
        summary: 's',
        actionItems: [{ text: 'a', isDone: false }],
        providerId: 'codex',
      },
      { status: 'no-transcript' },
      { status: 'not-found' },
      { status: 'busy' },
      { status: 'needs-setup', kind: 'Local', reason: 'model-missing' },
      { status: 'unavailable', reason: 'xai-removed' },
      { status: 'cancelled' },
      { status: 'failed', code: 'CliNotSignedIn', args: ['Codex', 2], detail: null, message: 'm' },
    ];
    for (const outcome of outcomes) {
      expect(generateOutcomeSchema.safeParse(outcome).success).toBe(true);
    }
    expect(generateOutcomeSchema.safeParse({ status: 'xai' }).success).toBe(false);
    expect(generateOutcomeSchema.safeParse({ status: 'failed', code: 'x' }).success).toBe(false);
  });

  it('refuses malformed input', () => {
    expect(summariesGenerate.input.safeParse({ meetingId: '', regenerate: false }).success).toBe(
      false,
    );
    expect(summariesGenerate.input.safeParse({ meetingId: 'a', regenerate: 'yes' }).success).toBe(
      false,
    );
    expect(
      summariesGenerate.input.safeParse({ meetingId: 'a', regenerate: true, templateId: null })
        .success,
    ).toBe(true);
    expect(summariesLoadTab.input.safeParse({ meetingId: null }).success).toBe(true);
    expect(
      summariesToggleAction.input.safeParse({ meetingId: 'a', index: -1, done: true }).success,
    ).toBe(false);
    expect(summariesCheckCli.input.safeParse({ kind: 'Xai' }).success).toBe(false);
    expect(summariesChooseCli.input.safeParse({ kind: 'Local' }).success).toBe(false);
    expect(summariesChooseLocalModel.input.safeParse({ fileName: '' }).success).toBe(false);
    expect(summariesProgress.payload.safeParse({ meetingId: 'a', running: true }).success).toBe(
      true,
    );
  });

  it('the gate answers unavailable for the removed provider, with no kind to set up', () => {
    expect(
      summariesProviderStatus.output.safeParse({ status: 'unavailable', reason: 'xai-removed' })
        .success,
    ).toBe(true);
    expect(
      summariesProviderStatus.output.safeParse({ status: 'needs-setup', kind: 'Xai', reason: 'x' })
        .success,
    ).toBe(false);
  });

  it('the wizard options carry rows and a default', () => {
    const parsed = summariesHardware.output.safeParse({
      hardware: { totalRamGb: 16, gpuName: null, gpuVramGb: null },
      rows: [],
      defaultFileName: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('summaries.replaceSummary (T4)', () => {
  it('is registered and accepts an answer or a restore', () => {
    expect(Object.keys(requestChannels)).toContain('summaries.replaceSummary');
    const input = summariesReplaceSummary.input;
    expect(
      input.safeParse({ meetingId: 'm1', source: { kind: 'answer', text: 'x' } }).success,
    ).toBe(true);
    expect(
      input.safeParse({
        meetingId: 'm1',
        source: { kind: 'restore', summary: null, actionItems: [{ text: 'a', isDone: true }] },
      }).success,
    ).toBe(true);
    expect(input.safeParse({ meetingId: 'm1', source: { kind: 'other' } }).success).toBe(false);
  });

  it('answers the previous content, busy, empty, not-found or failed as values', () => {
    const output = summariesReplaceSummary.output;
    expect(
      output.safeParse({ status: 'saved', previous: { summary: null, actionItems: [] } }).success,
    ).toBe(true);
    for (const status of ['busy', 'empty', 'not-found']) {
      expect(output.safeParse({ status }).success).toBe(true);
    }
    expect(output.safeParse({ status: 'failed', detail: 'locked' }).success).toBe(true);
    expect(output.safeParse({ status: 'saved' }).success).toBe(false);
  });
});

describe('action item deadlines (T4)', () => {
  it('registers the date and export channels', () => {
    for (const name of [
      'summaries.setActionItemDate',
      'summaries.setNextSessionDate',
      'summaries.exportActionItemsIcs',
    ]) {
      expect(Object.keys(requestChannels)).toContain(name);
    }
  });

  it('setActionItemDate takes a real day or null', () => {
    const input = summariesSetActionItemDate.input;
    expect(input.safeParse({ meetingId: 'm', index: 0, date: '2026-11-13' }).success).toBe(true);
    expect(input.safeParse({ meetingId: 'm', index: 0, date: null }).success).toBe(true);
    expect(input.safeParse({ meetingId: 'm', index: 0, date: '2026-02-30' }).success).toBe(false);
    expect(input.safeParse({ meetingId: 'm', index: -1, date: null }).success).toBe(false);
    const output = summariesSetActionItemDate.output;
    expect(output.safeParse({ status: 'saved', actionItems: [] }).success).toBe(true);
    for (const status of ['not-found', 'out-of-range', 'invalid-date']) {
      expect(output.safeParse({ status }).success).toBe(true);
    }
    expect(output.safeParse({ status: 'failed', message: 'm', detail: 'd' }).success).toBe(true);
  });

  it('setNextSessionDate takes a real day and answers the filled count', () => {
    const input = summariesSetNextSessionDate.input;
    expect(input.safeParse({ meetingId: 'm', date: '2026-11-13' }).success).toBe(true);
    expect(input.safeParse({ meetingId: 'm', date: null }).success).toBe(false);
    const output = summariesSetNextSessionDate.output;
    expect(output.safeParse({ status: 'saved', actionItems: [], filled: 2 }).success).toBe(true);
    expect(output.safeParse({ status: 'saved', actionItems: [] }).success).toBe(false);
    for (const status of ['not-found', 'invalid-date']) {
      expect(output.safeParse({ status }).success).toBe(true);
    }
  });

  it('exportActionItemsIcs takes item indexes and answers four outcomes', () => {
    const input = summariesExportActionItemsIcs.input;
    expect(input.safeParse({ meetingId: 'm', indexes: [0, 2] }).success).toBe(true);
    expect(input.safeParse({ meetingId: 'm', indexes: [-1] }).success).toBe(false);
    const output = summariesExportActionItemsIcs.output;
    expect(output.safeParse({ status: 'exported', count: 2 }).success).toBe(true);
    expect(output.safeParse({ status: 'failed', message: 'disk full' }).success).toBe(true);
    for (const status of ['cancelled', 'empty']) {
      expect(output.safeParse({ status }).success).toBe(true);
    }
    expect(output.safeParse({ status: 'exported' }).success).toBe(false);
  });
});
