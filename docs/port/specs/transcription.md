# Transcription module: behavior spec

Source of truth: the C# code in `MeetingLive.Core` and `MeetingLive.App` on branch `feat/electron-port`. All `file:line` references are relative to the repo root and were read at the time of writing. Paths abbreviate `MeetingLive.Core/Services` as `Core/S`, `MeetingLive.Core/Models` as `Core/M`, `MeetingLive.Core/Native` as `Core/N`, `MeetingLive.App` as `App`.

Names in this spec: "engine" is the Nemotron ASR runtime (a native DLL) plus the model file. "Live pass" is streaming recognition during recording. "Offline pass" is recognition over the finished WAV after Stop (and for import and re-transcription). "Draft" is the live pass output saved at Stop.

---

## 1. Purpose

The module turns meeting audio into a timestamped, optionally speaker-labelled plain-text transcript, entirely on the local machine.

1. Live pass: while recording, mixed mic and loopback PCM (16 kHz mono float32) is streamed into NVIDIA Nemotron 3.5 ASR Streaming 0.6B (through the NeMo-Speech.cpp C ABI). The recording page shows committed lines plus a rewritten interim suffix. Closing the live stream yields a draft transcript saved immediately.
2. Offline pass: after Stop, import, or re-transcription, the saved WAV is re-read and recognized again with a higher-accuracy latency profile and (optionally) a long-window speaker diarization geometry. The result replaces the draft when it contains text.
3. Engine management: download, verify, install, report backend (CPU or CUDA) and delete the engine (runtime zip plus GGUF model) and the optional Sortformer speaker model.
4. Transcript text utilities: stamp formatting, header lines, highlight starring, line indexing, committed-line parsing used by live-question detection and snippets.
5. Transcript polish (punctuation, casing, acronyms) through four interchangeable providers. This is implemented but not wired into any pipeline (see bug B2).
6. Re-transcription of a saved meeting through the same pipeline used after Stop.

Out of scope here but touched: audio capture, the recording pipeline orchestrator, summary providers, settings persistence, hardware detection, session page UI. Their interfaces are listed in section 5.4.

---

## 2. User-facing features

String keys are in `App/Strings/{en-us,es}/Resources.resw` unless marked `Core:` (`MeetingLive.Core/Strings/CoreStrings*.resx`). English values are quoted; Spanish values exist for every key and must be carried over in the same key set.

### 2.1 Record-time engine gate (`TranscriptionEngineResolver`)

File: `App/Services/TranscriptionEngineResolver.cs:13-19`, called from `App/Services/RecordingSetupResolver.cs`.

- `EnsureReadyAsync(root)` returns true immediately when `TranscriptionEngineInstaller.IsReady` is true (model file exists AND (CUDA runtime ready OR CPU runtime ready)). The diarization model is NOT part of readiness.
- Otherwise shows the modal setup dialog (2.2) and returns true only if the engine is on disk when the dialog closes. Cancel or failure means the caller must not start recording.

### 2.2 Engine setup dialog (`TranscriptionEngineSetupDialog` and its view model)

Files: `App/Dialogs/TranscriptionEngineSetupDialog.xaml(.cs)`, `App/ViewModels/TranscriptionEngineSetupDialogViewModel.cs`.

Layout: modal content dialog, title `EngineSetup.Title` "Download transcription engine"; only button is Close, text `EngineSetup.CloseButtonText` "Cancel" (default button is Close). Body (scrollable, max height 480, fixed width 420, spacing 16):
1. Hint caption (`EngineSetup_Hint.Text`, opacity 0.7): "Vozella needs NVIDIA Nemotron 3.5 ASR Streaming (about 0.74 GB) plus a small official NVIDIA runtime. Nothing else is installed — no Hugging Face CLI, no C++ build."
2. Determinate progress bar 0-100 (automation id `ProgressTranscriptionEngineDownload`).
3. Status text (automation id `TxtTranscriptionEngineStatus`), initial `Status_PreparingDownload` "Preparing download...".
4. Error info bar (severity Error, title `EngineSetup_Failed.Title` "Download failed", message = error text), open only when `HasError`.

Behavior:
- On dialog Opened the download starts automatically (`StartDownloadAsync`). Clears `HasError`/`ErrorText` first.
- Hardware is detected (`DetectHardware`), then `TranscriptionEngineInstaller.EnsureAsync` runs with a progress sink that posts to the UI thread: progress bar = `Percent`; status text = `"{StatusText}  {Percent:0}%"` (two spaces before the number).
- After `EnsureAsync` returns, readiness is re-checked with `IsReady`. If ready, `IsReady=true`, `Completed` fires and the dialog hides itself. If not ready: `HasError=true`, `ErrorText = Error_EngineNotReady` "Download finished but the transcription engine is still not ready."
- On cancellation (Close clicked calls `Cancel()` which cancels the token) the `OperationCanceledException` is swallowed silently; the dialog is closing.
- On any other exception: `HasError=true`, `ErrorText = ex.Message` (raw message), `StatusText = Status_DownloadFailed` "Download failed.". The dialog stays open; the only action is Cancel. There is no Retry button; the user closes and presses Record again.
- `ShowAsync` returns `ViewModel.IsReady`.

### 2.3 Live transcription during recording

Files: `Core/S/LiveTranscriptionService.cs`, `App/ViewModels/RecordingPageViewModel.cs:1255-1300,1335-1345,1500-1512` (consumer).

- Setting `LiveTranscriptionEnabled` (default true). When false, no live recognizer is created; only the offline pass runs after Stop.
- On record start (if enabled) the page shows `Status_LoadingModel` "Loading transcription model..." while `Start(language, recordedAt, speakerDiarizationEnabled)` runs off the UI thread. If `Start` or capture start throws, the page stops the live session, shows `Error_StartRecording` (formatted with the message) and restarts the mic preview.
- While recording, each processed frame raises `TranscriptUpdated(DisplayText, CommittedText)` on a background thread; the page marshals to the UI thread, sets `LiveTranscriptText = DisplayText` and uses `CommittedText` for live-question detection (a change is a new committed line; interim rewrites are not new lines).
- On Resume after a pause the page calls `SetClockSkew(pausedDuration)` (see B1: it has no effect).
- On Stop the page calls `Stop()` off the UI thread and keeps the returned text as `_liveDraft`. If `Stop()` throws, the page falls back to the text currently on screen (blank becomes null).
- The draft is saved immediately; the offline pass later replaces it when it yields text (see 3.12 for the stage rules).

### 2.4 Offline pass over a finished WAV

File: `Core/S/TranscriptionService.cs`. Used after Stop, after import, and by re-transcription (all through `RecordingPipelineOrchestrator`).

- Progress is reported as an integer percent of WAV duration; the pipeline shows `Status_TranscribingPercent` "Transcribing audio... {0}%" (initial `Status_Transcribing` "Transcribing audio...").
- Result: committed transcript text (header line, then stamped lines). Empty string when the stream produced nothing.
- Failure outcomes are decided by the pipeline (3.12) and surface as: `Status_LiveDraftKeptTranscriptionFailed` "Saved with the live transcript. The final transcription failed: {0}", `Error_TranscriptionFailedAudioKept` "Error: The meeting keeps its audio, so you can retranscribe it. Transcription failed: {0}", `Error_NoTranscript` "Error: No transcript was produced. The meeting keeps its audio, so you can retranscribe it.", `Error_EngineNotReady` (when the engine is not installed and there is no draft).

### 2.5 Re-transcription of a saved meeting

Files: `Core/S/MeetingRetranscription.cs`, `App/Services/MeetingRetranscriptionRunner.cs`, UI in `SessionPage` / `SessionPageViewModel` / `HistoryPageViewModel` (other module).

Availability (`Evaluate(record, isBusy, fileExists)`): checked in this order.
1. `record` null, or `AudioFilePath` null/whitespace: `NoAudio` (the disk is not probed for a blank path).
2. File does not exist (checks `record.AudioFilePath`): `NoAudio`.
3. `isBusy` true: `Busy`.
4. Otherwise `Available`.

Request (`CreateRequest(record, templateInstructions)`): a `RecordingPipelineRequest` with fields in this order: `record.Id`, `AudioFilePath`, `RecordedAt`, `EndedAt ?? default`, `Title`, `LiveDraft: null`, `PausedDuration: 0`, `FolderId`, `Highlights: []`, `CalendarEventId`, `CalendarId`, `SeriesId`, `JoinUrl`, `Attendees`, `Brief`, `Agenda: null`, `NoteTemplateId`, `templateInstructions`. Null record throws.

Runner (app-lifetime singleton, one run at a time; `StartAsync` returns false if already running):
- Sets `IsRunning`, `MeetingId`, `Status = Status_Transcribing`, remembers `record.Notes` as session notes, creates a fresh `CancellationTokenSource`, raises `StateChanged`.
- Resolves note-template instructions (`NoteTemplateInstructions.ResolveAsync`), then runs the shared pipeline with `LiveDraft=null`, so the previous transcript stays untouched until the offline pass succeeds.
- Pipeline callbacks update `Status` (raising `StateChanged`), call `Workspace.NotifyMeetingChanged(id)` on save, set `_completed` on `OnMeetingCompleted`, record `_summaryFailure` on `OnSummaryFailedAfterTranscriptSaved`, and set `_failure = status` on `OnFinished` unless cancellation was requested. `OnTranscriptRefreshed` is ignored.
- `OperationCanceledException` before the pipeline takes over is swallowed. Any other exception becomes `_failure = CliFailureUserMessage.Format(ex)`.
- Terminal step is enqueued on the UI dispatcher after the callbacks. Outcome precedence: `SummaryFailed` (summary failure message set) > `Failed` (failure set) > `Completed` (`_completed`) > `Cancelled` (cancel requested) > `TranscriptOnly`. `Message` is set only for `SummaryFailed` and `Failed`. State is reset (`IsRunning=false`, `MeetingId=null`, `Status=""`), `StateChanged` then `Finished(id, outcome, message)` are raised.
- `Cancel()` cancels the current token.
- Result strings (session page): `SessionRetranscribe_Title` "Re-transcribe this meeting?", `SessionRetranscribe_Content` "Re-transcribing "{0}" replaces its transcript with a new one made from the saved audio, then regenerates the summary. Any edits to the current summary will be lost.", `_Primary` "Re-transcribe", `_Cancel` "Cancel", `SessionRetranscribe_Done` "Re-transcribed. The transcript and summary were updated.", `_DoneNoSummary` "Re-transcribed. The transcript was updated, but no summary was generated.", `_Cancelled` "Re-transcription cancelled.", plus `SessionPage_Retranscribe*` automation names and `SessionPage_RetranscribeError.Title` "Re-transcription failed", `SessionPage_RetranscribeNotice.Title` "Re-transcription".

### 2.6 Settings: Transcription section (`TranscriptionEngineSectionViewModel`)

File: `App/ViewModels/TranscriptionEngineSectionViewModel.cs`. Strings: `Settings_Transcription.Text` "Transcription"; `Settings_NemotronCard.Header` "Nemotron 3.5 ASR Streaming 0.6B"; `.Description` "~0.74 GB model; runtime extra (CPU ~5 MB or CUDA ~106 MB). Official NVIDIA binaries — nothing else to install."; `Settings_DownloadEngine.Content` "Download"; `Settings_DeleteEngine.Content` "Delete"; `Settings_LiveTranscription.Header` "Live transcription during recording"; `.Description` "On-screen captions with Nemotron while you record. The saved transcript always uses Nemotron after you stop. Turning this off skips only the live preview."; `Settings_SpeakerLabels.Header` "Speaker labels"; `.Description` "Optional Sortformer model (~0.14 GB). Uses extra GPU/CPU while transcribing and labels up to four voices as Speaker 1–4. Turn off to transcribe without who-spoke tags."; `Settings_TranscriptionLanguage.Header` "Transcription language"; `.Description` "Pin the meeting language so transcription does not have to guess. Auto-detect is fine when meetings mix languages or you are not sure."

State and commands:
- Loaded from `AppSettings`: `IsLiveTranscriptionEnabled`, `IsSpeakerDiarizationEnabled`; plus `IsSpeakerDiarizationModelInstalled`, `IsTranscriptionEngineInstalled` (= `IsReady`), `_expectedBackend`.
- Toggle live transcription: no-op if unchanged; else set and persist `LiveTranscriptionEnabled`.
- Toggle speaker diarization: no-op if unchanged; set and persist `SpeakerDiarizationEnabled`; if enabling and the Sortformer model is not on disk, immediately start its download (B7: setting stays on if the download fails).
- Download engine: sets `IsTranscriptionDownloading`, progress 0, status `Status_StartingDownload` "Starting download..."; runs `EnsureAsync` (no cancellation token) with UI-marshalled progress (`"{StatusText}  {Percent:0}%"`); on success refreshes installed flag and expected backend; on exception sets the acceleration caption to `Error_DownloadFailedCaption` "Download failed: {0}" (ex.Message); always clears downloading flag, status text and progress. Relay command is non-reentrant by toolkit default.
- Delete engine: calls `DeleteEngine` (3.8), refreshes status, then overrides the acceleration caption: `RuntimeInUse` gives `Error_EngineDeleteInUse` "The engine is in use. Restart the app, then delete it."; `Incomplete` gives `Error_EngineDeleteIncomplete` "Part of the engine could not be removed. It may need to be downloaded again."; `Deleted` leaves the refreshed backend caption.
- Download Sortformer model: ignored while downloading; flag on, progress 0, status `Status_DownloadingSpeakerModel` "Downloading Sortformer speaker model..."; progress text `"{Status_DownloadingSpeakerModel}  {percent:0}%"`; on success `IsSpeakerDiarizationModelInstalled` is recomputed from disk and status text cleared; on failure status text becomes `Error_DownloadFailedCaption` formatted with the message; flag off and progress 0 in finally. `ShowSpeakerDiarizationProgress = downloading || statusText non-empty` (so a failure message stays visible).
- Delete Sortformer model: deletes the file, sets installed=false. Does not turn the setting off. No exception handling (B22).
- Backend status observation: `StartObservingBackend`/`StopObservingBackend` subscribe/unsubscribe to `AsrBackend.Changed` and `LiveDropsChanged` while Settings is visible; handlers marshal to the UI thread and re-apply.
- Acceleration caption: when no recognizer has been created in this process (`Current == null`): `Settings_AccelerationExpectedCuda` "Will try GPU (CUDA); the backend actually used is shown after the first transcription" if expected is CUDA else `Settings_AccelerationExpectedCpu` "Will use CPU". After a recognizer exists: `Settings_AccelerationActiveCuda` "Running on GPU (CUDA)" or `Settings_AccelerationActiveCpu` "Running on CPU".
- Fallback warning: if `Current.FallbackReason` is non-null, an info bar (`Settings_AsrFallback.Title` "GPU acceleration is not active") is open with `Settings_AccelerationFallbackMessage` "CUDA could not start, so transcription ran on the CPU and may be slower. Reason: {0}" (reason = raw exception message). Otherwise closed with empty message.
- Live-drop reporting: none until a live session has stopped in the process. After one: percent text = `DroppedPercent` formatted `"0.#"` in current culture. If `DroppedPercent > 5` (strictly): warning bar open (`Settings_LiveDropsWarning.Title` "Live transcript skipped audio") with `Settings_LiveDropsWarningMessage` "Live transcript skipped {0}% of the audio. The final transcript after Stop is complete; a slow backend (CPU) usually causes this." and the caption hidden. Otherwise caption visible: `Settings_LiveDropsCaption` "Last live session: {0}% of audio skipped" and warning closed.

### 2.7 Transcription language selection

Files: `Core/M/TranscriptionLanguageOption.cs`, `App/ViewModels/LanguageSectionViewModel.cs`.

- Catalog order and codes: `auto` (Core:LanguageAutoDetect "Auto (detect)"), `en` English, `es` Spanish, `pt` Portuguese, `fr` French, `de` German, `it` Italian, `nl` Dutch, `ja` Japanese, `zh` Chinese. Display names come from `Core:Language*` keys (Spanish translations exist: "Automático (detectar)", "Inglés", "Español", "Portugués", "Francés", "Alemán", "Italiano", "Neerlandés", "Japonés", "Chino").
- Summary-language catalog (separate, not transcription): `es` then `en`.
- Persisted as `AppSettings.TranscriptionLanguage` (string, nullable). `ResolveTranscriptionLanguage()` returns `"es"` when unset or whitespace (`Core/M/AppSettings.cs:58`). The settings UI selects the catalog entry whose code matches the resolved value, else index 0 (auto). Selecting an option saves its `Code` unless unchanged.
- The code is mapped to a Nemotron locale at use time (3.2).

### 2.8 Transcript polish (not reachable from the UI today)

See 3.14 and bug B2. Provider selection exists in `App/Services/AppServices.cs:131-137` (`CreateTranscriptPolisher(kind, localModelPath)`), mirroring the summary provider kind: Local, ClaudeCode, Codex, Xai. Failure is documented as non-fatal: the caller keeps the raw transcript.

### 2.9 Cloud transcription engines with the user's own API key (port addition, not in the WinUI app)

For a PC that cannot run the local engine. The user picks a cloud provider, pastes an API key from their own account with that provider, and records. Vozella hosts nothing and bills nothing: the provider charges the user's account. Sections 2.1 to 2.8 describe the local engine and still hold when it is the one in use.

**Engines and settings.** The engine in use is the setting `transcriptionEngine`: `Local` (the default, and what null or an unknown value means), `Groq`, `OpenAi` or `Deepgram` (section 2.10). The cloud engines are the rows of `CLOUD_TRANSCRIPTION_ENGINES` (core, `settings/cloud-transcription-engines.ts`); a row gives the speech models, the default model, the documented limits and the provider's key page. Name, endpoint and key come from the API engine of the same kind, so one key per provider serves summaries, chat and transcription. `cloudTranscriptionModelId` is the saved model, one setting whatever engine is selected. It is used only when the engine in use lists it (`resolveCloudTranscriptionModel`): null, blank, a model saved while another engine was selected and an id no row lists all resolve to the default of the engine in use (Groq `whisper-large-v3-turbo`, OpenAI `whisper-1`, Deepgram `nova-3`), so a model of one provider is never sent to another. Both settings are omitted from the file when null. A changed engine applies to the next pass, never to one that is running.

**Readiness.** A cloud engine is ready when the key of its provider is stored. Nothing is downloaded for it. `EngineStatusDto.ready` is about the engine in use; `engine` names it; `cloudNotReadyReason` is `key-missing` for a cloud engine without its key, else null. `modelInstalled`, `runtimes`, `usage` and `expectedBackend` keep describing the local engine. `transcription.ensureEngine` with a cloud engine answers `ready`, or `failed` with the `Ui_ApiKeyMissing` sentence, and downloads nothing; `{ local: true }` asks for the local engine whatever is selected, which is how Settings still downloads it.

**Status freshness.** The engine setting is saved through `settings.update` and the keys through the Settings key channels, both outside this module. Main publishes `transcription.statusChanged` again after a patch that names `transcriptionEngine` or `cloudTranscriptionModelId`, and after a key is saved or removed (not after a Verify). The Settings section and the live switch follow that event; the Record page reads `recording.getSetup` again on it while idle. No restart and no reload is needed.

**Settings, Transcription section.** In this order:
1. The choice, one radio group named `Ui_TranscriptionEngineChoiceLabel` "Where meetings are transcribed", under the line `Ui_TranscriptionEngineChoiceHelp`. Options: `Ui_TranscriptionLocalName` "On this PC" (`Ui_TranscriptionLocalHelp`), then each cloud engine by its product name with its mark (`Ui_TranscriptionCloudHelp`). A cloud option says "Key saved" or "Needs key" beside it, in words with a glyph, and in the radio's accessible name. Choosing an option saves the setting; choosing this PC saves null. The saved cloud model is kept when the newly chosen provider lists it, and cleared otherwise.
2. With a cloud engine in use, its setup (a group named `Ui_CloudSetupGroup` "{provider} setup"):
   - `Ui_CloudAudioNotice`: "While {0} is selected, the audio of each meeting is sent to {0} to be turned into text." A notice with a glyph; it is the only place the product sends audio off the PC, and it names the provider.
   - The API key row of the API engines (the same component: field, Save key, Verify, Remove key, status line), for this provider. A Verify that passes says `Ui_ApiVerifiedKeyWorks`. Under it `Ui_CloudSameKey`: the same key also works for summaries and chat with that provider.
   - `Ui_CloudKeyGuideTitle` "How to get a {0} API key": a disclosure, open while no key is saved and folded once one is. Four numbered steps: a link to the provider's key page (`keyPageUrl`: `https://console.groq.com/keys`, `https://platform.openai.com/api-keys`), sign in or create an account, create a key and copy it, paste it and select Save key. Then `Ui_CloudKeyGuideCost`: the provider bills the user's own account; no price is quoted. The link opens in the system browser through the window-open handler, which hands over https addresses only.
   - `Ui_CloudModelLabel` "Transcription model": a select with the models of the row by their names, described by `Ui_CloudModelHelp`. A saved id the row does not list is not offered: the row shows the default, which is what is sent. An engine with one model (OpenAI, Deepgram) has nothing to choose, so the row names that model as text, described by `Ui_CloudModelOnlyHelp`, with no select. The list a Verify returns is not used: it leaves speech models out.
3. The local engine row (2.6). With a cloud engine in use it is titled `Ui_EngineLocalTitle` "Engine on this PC", says it is not in use (`Ui_EngineLocalUnused`), reports what is on disk, and keeps Download and Delete. The processor caption is shown only for the local engine, or when a download failed.
4. Live transcription. With a cloud engine: `Ui_LiveCloudDescription` (the text appears a few seconds after it is said); without its key the switch is off and disabled with `Ui_LiveNeedsKey`.
5. Speaker labels. With a cloud engine the saved switch is shown disabled, with `Ui_SpeakerLabelsCloudUnavailable` as the description of the row and of the switch; the speaker model buttons are not drawn. The saved value is not changed.

A link from the Record page (`openTranscriptionInSettings`) opens Settings with the section in view and the focus on the key field (`key`) or on the engine in use (`choice`). It never changes the engine.

**Record gate.** With a cloud engine without its key, `recording.getSetup` answers `engine.reason = 'key-missing'` with the detail `Ui_ApiKeyMissing` and the provider's name. The setup panel then reads `Ui_SetupCloudKeyHeadline` "Add your {0} API key to record. Nothing needs to be downloaded." and its one button is `Ui_SetupAddKey` "Add API key", which opens Settings on the key field. The checklist dialog (opened by a Record or an Import that main refused) has the same headline and the same button in place of "Set up". The engine download dialog (2.2) never opens for a cloud engine, so its "Download failed" is never shown for a missing key.

With the local engine missing, the download dialog (2.2) carries a secondary way out under the progress, also beside a failed download: `Ui_EngineSetupCloudHint` and the button `Ui_EngineSetupUseCloud` "Use the cloud instead". It cancels the transfer, ends the setup pass without the "Setup cancelled" notice, changes no setting, and opens Settings on the engine choice.

**Live pass.** This paragraph is about an engine whose live text arrives in pieces (`liveText: 'pieces'`, Groq and OpenAI); an engine that streams is section 2.10, and the notice below is the same for both. The cloud stream cuts the audio in pieces of about 15 s at a quiet point and uploads them in order, so the live text is one piece behind. The empty canvas says `Ui_LiveCloudHint`. A failed piece that waiting can fix (rate limit, network, timeout) is a gap, counted in `liveDroppedPercent`. A failure waiting cannot fix (`KeyMissing`, `KeyInvalid`, `QuotaExceeded`, `ModelNotFound`) ends the uploads of that take; the recording goes on. Main then sets `RecordingStateDto.liveNotice` (`Ui_CloudLiveStopped`, with the provider's reason as a sentence) while the take records, and the page shows it above the live text as a polite status titled `Ui_CloudLiveStoppedTitle` "Live captions stopped": the reason, that the recording continues, and that it can be transcribed after Stop. It is not an alert and blocks nothing. It is cleared when the take stops recording and by the next take.

**What is not uploaded.** A piece in which no 50 ms frame reaches -60 dBFS (`CLOUD_SILENCE_RMS` 0.001: a muted source, far under quiet speech) is not sent, in the live pass and in the offline pass: models of this kind tend to repeat the prompt when asked to transcribe silence, and silence is not worth paying for. A final tail shorter than 100 ms (`CLOUD_MIN_UPLOAD_MS`) is not sent either: providers refuse audio that short. Both count as covered audio with no text, never as a gap, and the pieces after them keep their real times.

**Words and punctuation.** The provider's word list may carry no punctuation or capitals while its text does. When the text splits on spaces into as many tokens as there are words, the tokens are the word texts and the provider's timings stay; otherwise the provider's words are used. The lines of a piece longer than 30 s, or with a pause between ideas, are rebuilt from the words, so this is what keeps their punctuation.

**Waits.** Requests of one provider are spaced 3 s apart by one pacer shared by every pass of the app (the live pass, the pass after Stop, a re-transcription). A rate limit (429) is waited out before the same piece is sent again, up to 4 times per piece. The offline pass waits what `retry-after` asks up to one hour (`CLOUD_RATE_LIMIT_MAX_WAIT_MS`, the longest window a provider counts a limit over); the pass can be cancelled meanwhile, and a longer wait fails it with the rate limit. The live pass holds every request for as long as it is asked: the audio that arrives meanwhile waits in the buffer (five minutes, then the oldest is dropped and counted as a gap). A network failure, a timeout and an HTTP 5xx are sent again twice, after 3 s and 6 s; a 5xx of a speech request reads as `TimedOut` (the chat and summary engines keep reading it as `Unknown`).

**Stop.** Stop transcribes what the live pass still holds and waits for it, but no longer than 25 s (`LIVE_STOP_DEADLINE_MS`), so a stalled upload, a rate limit or a client that never answers cannot hold the meeting from being saved. Past the deadline the uploads are cancelled; the piece in flight and everything still waiting count as lost audio, so the draft is not complete and the pass after Stop transcribes the recording.

**No second upload.** When the live pass of a cloud engine transcribed every sample of the take (it drained with nothing lost, no frame was dropped, no call failed, there is text, and the capture stopped without an error), its draft is the saved transcript and the pass after Stop does not run. The pass after Stop runs for an import, a re-transcription, live transcription turned off, a draft with gaps, a Stop cut off at its deadline, and always for the local engine. Reason: the provider limits below would throttle a second pass over a long meeting.

**After Stop.** A failed pass is worded with the API failure sentence inside `Status_LiveDraftKeptTranscriptionFailed` or `Error_TranscriptionFailedAudioKept`. When the engine stopped being ready during the take and there is no draft, the local engine keeps `Ui_TranscriptionEngineUnavailable` (install the engine) and a cloud engine gets `Ui_CloudTranscriptionKeyMissingAudioKept` (add the key in Settings, then retranscribe). Re-transcription without the key fails with the `Ui_ApiKeyMissing` sentence and keeps the old transcript.

**Limits (v1).**
- No speaker labels: the endpoint returns no speakers.
- Live text is about one piece (15 s) behind, and a live result that returns during a pause shows when the next frame arrives.
- Groq's developer plan allows 20 requests per minute and 7,200 audio seconds per hour for the whisper models; the engine paces requests 3 s apart and honors `retry-after` as described under Waits. While an offline pass waits out a long limit the status keeps its last percent; nothing says it is waiting.
- Silence is recognized by level only: room noise above -60 dBFS is still uploaded, so a model can still answer a quiet stretch with repeated text.
- Uploads are PCM16 WAV pieces, not compressed; a piece above 25 MB is refused before upload.
- OpenAI lists `whisper-1` as deprecated with shutdown on 2027-02-26. Only the models a row lists are sent, so its successor needs a release that adds it to the row before that date.
- A hosted Vozella service and subscription sign-in are out of scope. A provider with its own API is section 2.10.

### 2.10 Deepgram, a provider that only transcribes and streams (`odd/tasks/deepgram-streaming-transcription.md`)

Deepgram is a third cloud engine, the first that streams: one live session per recording, with text that follows the speech word by word. What section 2.9 says holds for it unless this section says otherwise. Not yet run against the real service from the app (the opt-in live test is task T4 of the feature document).

**Not an API engine.** Deepgram writes no summaries and answers no chat, so it is not a row of `API_ENGINES`. It is a row of `TRANSCRIPTION_PROVIDERS` (core, `settings/transcription-provider-table.ts`): product name, name key (`Ui_DeepgramName`), endpoint (`https://api.deepgram.com/v1`) and how its key is checked. Its row in `CLOUD_TRANSCRIPTION_ENGINES` gives the rest: protocol `deepgram-listen`, model `nova-3` ("Nova-3", the only one), no documented limits (all null), key page `https://console.deepgram.com/`, and `liveText: 'streaming'` (Groq and OpenAI are `'pieces'`). `cloudTranscriptionProvider(kind)` answers the name, endpoint and key kind of any cloud engine, from whichever of the two tables holds it. Nothing that lists the API engines lists Deepgram: the summary and chat choices, the setup wizard and the API key group of Settings never show it (`api-provider-edit-points.test.tsx` proves it). The next provider of this kind is a row in each of the two tables, its kind in contracts, its name in both locales and its mark.

**Key.** One key per kind in the same `ApiKeyStore` (`ApiKeyKind` is an API engine kind or a transcription-only kind). The key of a transcription-only provider has its own channels, because the settings key channels take API engines only: `transcription.setProviderKey`, `transcription.clearProviderKey` and `transcription.verifyProviderKey`. They behave like the settings ones: the key travels to main once and never back, a blank key removes it, and answers carry a flag or the catalog key of the reason. Verify is `GET {endpoint}/projects` with `Authorization: Token <key>`: any 2xx is `verified` (no model list), 401 and 403 are `Ui_ApiKeyInvalid`, 402 `Ui_ApiQuotaExceeded`, 429 `Ui_ApiRateLimited`, no saved key `Ui_ApiKeyMissing` without a request. Main publishes the engine status again after a save or a remove, not after a Verify. In the fake native build Verify answers `verified` without opening a connection. `SettingsPageDto.transcriptionKeys` says, per cloud engine, whether its key is saved; the Transcription section reads the key flags from there for every cloud engine.

**Settings, Transcription section.** Deepgram is the last option of the choice, with its mark. Its line is `Ui_TranscriptionStreamingHelp` (the text appears as you speak). Its setup is the one of 2.9 with these differences: under the key row `Ui_CloudKeyTranscriptionOnly` (the key is used only to transcribe) instead of `Ui_CloudSameKey`; the model row names Nova-3 with no select (one model); the live switch is described by `Ui_LiveStreamingDescription`, and without the key it is off with `Ui_LiveNeedsKey` like every cloud engine. `Ui_CloudAudioNotice` reads the same and is still true: the audio goes to Deepgram while recording and, when a pass after Stop runs, again as an upload. Speaker labels are unavailable as with every cloud engine.

**Engine selection.** `TranscriptionRuntime.engine()` (platform) answers the engine of the settings each time a pass starts. For a cloud kind, the `liveText` column of its row picks the provider, with no branch on a provider's name:

- `pieces`: `CloudSpeechEngineProvider` (2.9). Every pass uploads through the provider's `SpeechToTextClient`.
- `streaming`: `StreamingSpeechEngineProvider` (core, `transcription/speech-engine-provider.ts`). The latency profile of the pass picks how the audio travels. A `live` pass is one session of the `StreamingSpeechProvider` behind the streaming speech engine. An `offline` pass (the pass after Stop, an imported file, a re-transcription) uploads the finished recording through the `SpeechToTextClient` behind the cloud speech engine of 2.9, with the same pieces, pacer (one per provider), retries and rate limit waits. If no streaming provider can be built for the kind, its live pass falls back to pieces through the client.

Both are ready when the key of the kind is stored and with nothing else, so readiness, `cloudNotReadyReason` (`key-missing` or null), `transcription.ensureEngine` and the Record gate behave for Deepgram exactly as in 2.9: without the key the gate reads `Ui_SetupCloudKeyHeadline` and `Ui_ApiKeyMissing` with "Deepgram", with it the gate is gone. Nothing is built, opened or uploaded until a pass starts. The runtime takes the two factories from the composition (`cloud.client`, `cloud.streaming`): the app passes `createCloudSpeechToTextClient` and `createStreamingSpeechProvider`, both with the saved model resolved for the kind (2.9); the fake native build passes `FakeSpeechToTextClient` and `FakeStreamingSpeechProvider`, so it never opens a connection.

**Live behavior.** While recording, interim results rewrite the last line and final results commit it (3.6), usually within a second of the speech. The empty canvas says `Ui_LiveStreamingHint` ("Captions appear here as people speak."), not the pieces hint. Three endings:

- Nothing lost. Stop finishes the session and waits for its last finals (the 25 s deadline of 2.9 applies). The session answered for every sample, so the draft is the transcript and the pass after Stop does not run (2.9, No second upload): the audio is not uploaded again.
- A failure waiting cannot fix: a refused key (`KeyInvalid`), no credit (`QuotaExceeded`), no stored key (`KeyMissing`), an unknown model (`ModelNotFound`). The session ends and is not opened again; the same `onLost` listener as the uploads raises the live notice of 2.9 once (`Ui_CloudLiveStopped` with the reason), the recording goes on, later audio is counted as lost, and the pass after Stop uploads the recording (and says so itself if the provider refuses that too).
- A failure waiting may fix: a dropped connection, a timeout, a session that never opened. No notice. The audio after the last final result and everything recorded after it count as lost (`liveDroppedPercent`), the text committed before the drop stays on screen, the draft is not final, and the pass after Stop uploads the whole recording.

**Timers.** The uploads and the streaming session wait on separate clocks in the runtime (`cloud.timer`, `cloud.streamingTimer`), both the system timer in the app and in the fake native build. They are separate because a session's open timeout and the adapter's KeepAlive loop must really wait: a test clock that resolves every wait at once (the one that paces uploads in unit tests) would give a session up as it was asked for.

**Streaming seam.** `StreamingSpeechProvider` (core, `transcription/streaming-speech.ts`) is the port of a provider that listens while the audio arrives. It speaks of sessions only: `open({ language, sampleRate, cancel }, listener)` returns a session with `send(samples)`, `finish()` and `close()`; the listener hears `opened`, `interim(result)`, `final(result)` and `closed(error | null)`. A result is its text, its words with times in milliseconds from the first sample sent, and how far the provider has listened (`processedMs`). No socket and no provider message name crosses the port, so the next streaming provider is one adapter. `StreamingSpeechEngine` (core, `transcription/streaming-speech-engine.ts`) puts any such provider behind the `AsrEngine` port:

- One session per stream, opened with the first audio at its sample rate (every later frame is taken to have that rate, as in the cloud engine). `push` never waits and never throws. Audio pushed before the session opens waits (up to 30 s, `STREAMING_MAX_BUFFERED_MS`; past it the oldest is dropped, counted as lost, and the times of the results are shifted by it) and is sent in order on open. A session that has not opened after 15 s (`STREAMING_OPEN_TIMEOUT_MS`) fails as `TimedOut`.
- An interim result becomes an `AsrResult` with `isFinal: false`, which the accumulator shows as the rewritten suffix; a final one becomes `isFinal: true` and is committed. Words are untagged (`speakerTag` 0) and carry the provider's punctuated text; the transcript is the provider's text, else the words joined. Results without words are not emitted; a final without words still counts as audio the provider listened to.
- `drain()` finishes the session, waits for its last finals and answers the audio that was pushed and never confirmed: the audio dropped before the open, the audio sent after the last final result of a session that failed, and the audio pushed after a failure or after the drain began. A session that ends cleanly after `finish` lost nothing of what it was sent, so the answer is then exactly 0 and the pass after Stop is skipped (2.9, No second upload). Closing the stream, or cancelling the pass, during a drain ends it at once with the unconfirmed audio lost.
- A session that ends early is not opened again in this version. The failure goes once to the same `onLost(error, lostMs)` callback as the cloud engine's, so `KeyMissing`, `KeyInvalid`, `QuotaExceeded` and `ModelNotFound` raise the live notice of 2.9 and any other failure is a gap; the pass after Stop covers the recording.
- It serves the live pass only: asked for the `offline` profile it rejects. The pass after Stop, imports and re-transcription use the provider's `SpeechToTextClient` behind the cloud speech engine of 2.9.

**Deepgram adapters.** Both live in platform (`transcription/`); `createStreamingSpeechProvider` and `createCloudSpeechToTextClient` (`cloud-speech-factory.ts`) pick them by the `protocol` of the engine's row (`createStreamingSpeechProvider` answers null for a provider whose live text arrives in pieces).

- Live, `DeepgramLiveSpeechProvider`: one `wss://api.deepgram.com/v1/listen` socket per session on the runtime's own `WebSocket` (`globalLiveSocket`: `new WebSocket(url, { headers })`, no `ws` dependency), with the key in the `Authorization: Token` header only, never in the URL. That the main process of Electron sends the header was observed on Electron 45.2.1 (Node 24.22.1) against a server on 127.0.0.1 and is kept as an e2e test (`deepgram-streaming.spec.ts`); a refused upgrade there ends as `error` then `close` 1006, as a refused key does. Query: `model`, `encoding=linear16`, `sample_rate`, `channels=1`, `interim_results=true`, `punctuate=true`, `smart_format=true`, `language`. Audio goes out as 16-bit little-endian PCM binary frames; a `KeepAlive` text frame goes out every 4 s while the socket is open. `finish` sends `Finalize` then `CloseStream`; the session is complete at the `Metadata` message, or at close code 1000. `Results` are read as interim (`is_final` false) or final, with `punctuated_word` (else `word`) and `start`/`end` in seconds from the start of the stream; `processedMs` is `start + duration`. Any other message, and any message that is not well formed, is ignored.
- Language: a Spanish tag (`es`, `es-US`) is `es`, the explicit tag `es-419` stays `es-419`, an English tag is `en`; anything else, `auto` included, is `multi`, with `endpointing=100` on a live stream.
- Live failures. A socket that never opens says only "close 1006", for a refused key and for a dead network alike, so the adapter then sends the Verify request (`GET /v1/projects`, 8 s): its failure is the reason (401 `KeyInvalid`, 402 `QuotaExceeded`, unreachable `Network`, no answer `TimedOut`), and an accepted key leaves `Network`. No stored key is `KeyMissing` without a socket. After the open: an `Error` message ends the session with the kind of its code (`INVALID_AUTH` `KeyInvalid`, `ASR_PAYMENT_REQUIRED` `QuotaExceeded`, `TOO_MANY_REQUESTS` `RateLimited`, `NET-0001` `TimedOut`, else `Unknown` with its text); close 1011 is `TimedOut`, 1008 `Unknown` with its reason, any other close (a 1000 nobody asked for included) `Network`. The key is scrubbed from every text kept.
- Recorded audio, `DeepgramSpeechToTextClient`: `POST {endpoint}/listen?model=…&punctuate=true&smart_format=true&language=…` with the piece as a raw `audio/wav` body (`ApiRequest.bytes` in `api-http`) and `Authorization: Token`. It reads `results.channels[0].alternatives[0]` (`transcript`, `words[]`) and `metadata.duration`. 401 and 403 are `KeyInvalid`, 402 `QuotaExceeded`, 429 `RateLimited` with its `retry-after`, 5xx and 504 `TimedOut` (sent again by the cloud engine), anything else `Unknown`. The prompt of a piece is not sent: the endpoint has no parameter for it.
- Fake, `FakeStreamingSpeechProvider` (platform, `fakes/`): one word of the fake script per half second of audio, as an interim result that grows word by word and a final when the phrase ends. `VOZELLA_FAKE_STREAM_DELAY_MS` delays the open and every result; `VOZELLA_FAKE_STREAM_FAIL` refuses every session with that failure kind.

**Limits (v1).**
- A dropped live session is not opened again during the recording; the pass after Stop covers it.
- No speaker labels, as with every cloud engine. Deepgram's own diarization is not requested.
- How an account without credit presents on the live socket is not verified. If it is a bare close 1006 the key check answers 200 and the live pass ends as `Network` (no notice); the pass after Stop then fails with 402 and says so.
- Audio sent to an open socket is not bounded on this side if the network stalls; the server's 10 s rule or the TCP timeout ends such a session.
- Languages other than Spanish and English go to `multi`, which Deepgram's docs do not list for every language.

---

## 3. Domain rules

### 3.1 Audio contract

- Live: `IAudioCaptureService.PcmFrameAvailable` raises `PcmFrameEventArgs(Samples: float[] mono, SampleRate: int)`. The capture mix format is 16 kHz mono IEEE float (`Core/S/AudioCaptureService.cs:16`). Imports are converted to 16 kHz mono 16-bit PCM WAV (`AudioImportService`, `TargetSampleRate = 16000`).
- Offline: `TranscriptionService.FrameFloats = 1600` (100 ms of 16 kHz mono). The reader is NAudio `AudioFileReader` (converts to float); the buffer is `1600 * channels` floats; channels are averaged to mono per frame (`sum / channels`); the actual reader sample rate is passed to the engine with each push. A trailing partial frame is processed as-is. An empty mono result is skipped.
- Before reading, `WavHeaderRepair.Repair(path)` fixes RIFF/data chunk sizes of 0 left by a process that died mid-recording (result ignored).

### 3.2 Language mapping (`NemotronLanguageMapper`)

Trim + lowercase; null/whitespace gives `auto`.

| code | locale |
|---|---|
| auto | auto |
| en | en-US |
| es | es-US |
| pt | pt-BR |
| fr | fr-FR |
| de | de-DE |
| it | it-IT |
| nl | nl-NL |
| ja | ja-JP |
| zh | zh-CN |
| anything else | auto |

### 3.3 Latency profiles and geometry

- `AsrLatencyProfile.Live` = encoder right-context 6 frames (560 ms; it was 3 frames, 320 ms, until the second-pass spike showed 6 fixes live word errors for about 0.15-0.19 s more delay). `Offline` = 13 frames (1.12 s). Supported model values are 0, 1, 3, 6, 13 only (160 ms = 1, 560 ms = 6).
- `SortformerGeometry.Streaming` passes 0 for every frame field (library defaults, about 1.6 s). `Meeting` passes the very-high-latency NVIDIA profile (80 ms frames): chunk 340, right context 40, left context -1, fifo 40, speaker cache 188, update period 300 (30.4 s input buffer). Left context is `-1` in both geometries (0 is a valid value so -1 is the "default" sentinel). The C ABI applies a field only when chunk/right/fifo/spkcache/update > 0 and left >= 0.
- **Port divergence: live preset.** The Electron port's Streaming geometry is the model card "low latency" profile instead of the library defaults: chunk 6, right context 7, left context -1, fifo 188, speaker cache 188, update period 144 (1.04 s input buffer). The library defaults are not documented in the v0.3.0 header (it only says "geometry uses streaming defaults unless overridden"), so the live labels now come from a published, reproducible preset. Meeting (offline) is unchanged. Source: https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.
- Live pass: Live latency + Streaming geometry. Offline pass: Offline latency + Meeting geometry.

### 3.4 Recognizer creation and backend choice (`NemoSpeechRecognizerFactory`)

Inputs: models, runtime manager, engine, hardware detection, optional backend status.

1. Model path is read; if the ASR model file is missing throw `InvalidOperationException("The Nemotron ASR model is not installed.")`.
2. Diarization model path is used only if diarization is enabled AND the Sortformer file exists; if enabled but the file is missing the recognizer is created without diarization and no error is raised.
3. `preferred = SelectBackend(hardware)`: CUDA if `HasNvidiaGpu()` else CPU. `HasNvidiaGpu` is true when `GpuName` is non-blank and contains (case-insensitive) NVIDIA, GeForce, Quadro or Tesla.
4. If preferred is CUDA and the CUDA runtime is ready: try `CreateRecognizer(model, cudaBin, gpu: 0, diar, geometry, latency)`. On any exception capture `ex.Message` as `fallbackReason`. On success report `AsrBackendUsage(Cuda, null)` and return.
5. If the CPU runtime is not ready throw `InvalidOperationException("The Nemotron ASR CPU runtime is not installed.")`.
6. Create on CPU with `gpu: -1`, report `AsrBackendUsage(Cpu, fallbackReason)` (reason null unless CUDA was preferred, ready, and failed). Latency and geometry are preserved across fallback. A machine without an NVIDIA GPU, or with a missing CUDA runtime, reports Cpu with no reason.
7. `IAsrBackendStatus.Report` raises `Changed` on the caller's thread.

### 3.5 Native recognizer configuration (Windows DLL, `nemo_speech_asr_c.dll`)

Config built in `Core/N/NemoSpeechNativeLibrary.cs:107-212`. The Electron port will bind the same C ABI (or a replacement) and must reproduce these values.

- Backend: `gpu` (0 for CUDA, -1 for CPU).
- Model: path UTF-8, name NULL.
- Streaming: `chunk_size = 0.16` s, `ctc_left_padding = 1.92`, `ctc_right_padding = 1.92`, `rnnt_right_context = profile frames (3 or 13)`.
- Diarization (only when a diarization path was given): geometry from 3.3.
- Endpointing: enabled, `vad_based = 0` (energy based, no extra model), `stop_history_eou_ms = 800`. Rationale in code: without endpointing the server emits a single final only at stream close, which the app never does, so no final would arrive; on real meeting audio 800 ms gave about 8 finals per 52 s and 500 ms gave 9 with more mid-sentence cuts.
- Postproc, decoder, VAD, batching: NULL.
- Recognition options (both streaming and one-shot): language code UTF-8 string; `interim_results` = true for streaming and false for one-shot; `enable_word_time_offsets = 1`; `enable_automatic_punctuation = 1`; `verbatim_transcripts = 0`; `profanity_filter = 0`; `stop_history_eou_ms = 0`; no speech contexts; `max_alternatives = 1`; `enable_speaker_diarization` = whether a diarization model was configured; `max_speaker_count = 0`.
- Struct sizes (x64 MSVC): backend 16, model 24, streaming 24, diar 40, endpointing 16, recognizer config 80, recognition options 72. Booleans are 1 byte. Offsets are in `Core/N/NemoSpeechNativeStructs.cs`.
- Exports bound by name: `nemo_speech_asr_create`, `_destroy`, `_recognize_f32`, `_streaming_recognize`, `_stream_push_f32`, `_stream_finish`, `_stream_next`, `_stream_close`, `_result_is_final`, `_result_audio_processed`, `_result_transcript` (alt 0), `_result_word_count`, `_result_word_start_time` (ms int), `_result_word_end_time` (ms int), `_result_word_text`, `_result_word_speaker_tag`, `_result_destroy`, `_last_error`. Status 0 is OK. Non-OK or NULL handle throws `InvalidOperationException("<fn> failed: <last_error>")`.
- Library load: `SetDllDirectory(bin)` and best effort `AddDllDirectory(bin)`, then `NativeLibrary.Load(bin\nemo_speech_asr_c.dll)`. Loaded libraries are cached per canonical bin directory (case-insensitive) for the life of the process; a failed load caches nothing and the next call retries; loads are serialized across all keys because they mutate the process DLL search path. The library is NEVER unloaded: freeing it while CUDA/ONNX worker threads run aborts the process (ucrtbase 0xC0000409). `NemoSpeechNativeLibrary.Dispose` is deliberately a no-op.
- Results: each stream result is read fully into a managed record and destroyed immediately. A result has `IsFinal`, `Transcript`, `AudioProcessedSeconds` (float), and a word list of `(startMs, endMs, speakerTag, text)`; tags are 1-based (Sortformer max 4), 0 means untagged.
- Never call `stream_finish` on a live or offline stream (`FinishAndDrain` exists on the interface but is unused by production code): it aborts the process on a long CUDA session. Streams and recognizers are closed by `Dispose` so the offline pass can create another recognizer.

### 3.6 Streaming accumulator (`StreamingTranscriptAccumulator`)

Constructed with `recordedAt` (`default` means unknown). Constants: `WindowLength = 30 s`, `IdeaPause = 500 ms`. State: committed line list, current interim text (string, may contain several lines), `_lastEnd`, `_wroteHeader`, public `ClockSkew` (unused).

`Apply(result)`: `text = result.Transcript.Trim()`.
- Final: if text non-empty, ensure header, then append every line from `FormatWindows(result, text, commitTiming: true)`. In all final cases the interim is cleared (a final with empty text still clears it).
- Interim (not final): interim = "" if text is empty, else the lines of `FormatWindows(..., commitTiming: false)` joined with `Environment.NewLine` (CRLF on Windows).

`EnsureHeader`: adds `Recorded yyyy-MM-dd HH:mm` (local time) as the first committed line once, only when `recordedAt != default`.

`DisplayText`: if no committed lines: empty if no interim; otherwise `interim` alone when `recordedAt == default`, else `header + NewLine + interim`. With committed lines: `committed.join(NewLine)` plus `NewLine + interim` when interim non-empty.

`CommittedText`: committed lines joined with `Environment.NewLine`.

`CommitRemainingInterim`: if interim is blank do nothing; else ensure header, split interim on `\r\n` or `\n` removing empty entries, append each as a committed line, clear interim. (Used at Stop and at end of the offline pass.)

`FormatWindows(result, text, commitTiming)`:
1. Range. With words: `start = Words[0].Start`, `end = Words[^1].End`. Without words: `start = _lastEnd`, `end = AudioProcessedSeconds` as TimeSpan, clamped to be >= start. For an interim result without words where `end == start`, yield the bare text (no stamp) and stop.
2. If `commitTiming`, `_lastEnd = end` (interim results never advance `_lastEnd`).
3. No words: spread over untimed windows (below).
4. With words: if `end - start <= 30 s` AND all words have the same speaker tag AND no idea pause (any gap `word[i].Start - word[i-1].End >= 500 ms`), yield one line with `Words[0].SpeakerTag`.
5. Otherwise tokens: `ResolveTokens` = whitespace-split text (regex `\s+`, empty removed); if the word count equals the split count and every word has a non-null `Text`, use the engine word texts instead; else use the split tokens. If no tokens, yield one line for the whole range.
6. `pairCount = min(tokens, words)`. Walk `i in [0, pairCount)` building windows. Start a new window when the current window is non-empty AND any of: speaker tag differs from the window's speaker; `word.End - windowStart >= 30 s`; `word.Start - previousWordEnd >= 500 ms`. A closed window is `(windowStart, previousWordEnd, tokens, windowSpeaker)`; a new window starts at the word's `Start` with the word's speaker. After the loop flush the open window.
7. If `tokens > pairCount`, extra tokens are appended to the last window (or form a window `(start, end, extra, speaker 0)` if none).
8. Each window with non-empty joined text (tokens joined with a single space) yields `FormatLine(windowStart, windowEnd, text, speakerTag)`.

**Port divergence: speaker smoothing (Electron port, `speaker-smoothing.ts`).** Sortformer tags every word on its own, so the C# rules above split a sentence whenever one word flickers to another speaker, and a line whose first word is untagged gets no label. Before step 4 the port cleans the word tags, working inside pause-free runs only (words closer than `IdeaPause`), so nothing is carried or merged across an idea pause:
- Untagged fill: a word with tag 0 takes the previous tagged word's speaker in its run, or the next one when it leads the run. A run with no tagged word stays untagged.
- Flicker: a speaker run shorter than `MIN_SPEAKER_RUN_WORDS = 2` words AND `MIN_SPEAKER_RUN_MS = 500 ms` (first word start to last word end) takes the surrounding speaker when both neighbors in the run agree, otherwise the longer neighbor (by duration, the previous one on a tie), or its only neighbor at the edge of a run. Consecutive short runs are absorbed as one group. A short run alone in its pause-free run stays.
- Label: a line is labelled with the majority tag of its words (tags above 0; a tie goes to the speaker heard first). Step 4 and the no-token line use it instead of `Words[0].SpeakerTag`; after smoothing every window is single-speaker, so the windows keep their own speaker.

Results with no tags, or a single speaker, are returned unchanged, so the output without diarization is identical to the C# rules. A real two-word interjection ("yes, sure") is kept; a single short word from another speaker inside someone's sentence is not.

**Port divergence: the local user as "You" (Electron port, `mic-activity.ts`, `local-speaker.ts`).** The recording is one mixed stream, so Sortformer cannot tell the microphone from the meeting audio. The capture side measures the RMS of the microphone and of the output before mixing, per `MIC_ACTIVITY_FRAME_MS = 50 ms` frame, and `MicActivityRecorder` keeps the ranges where the microphone dominates:
- A frame is `microphone` when the mic RMS is at least `MIC_NOISE_FLOOR_RMS = 0.01` (about -40 dBFS) AND at least `MIC_DOMINANCE_RATIO = 2` times the output RMS (about 6 dB); `output` when the output is above the floor and louder than the mic; otherwise `quiet` (double talk and bleed count as quiet). Speaker echo and headset bleed reach the mic far weaker than the digital output, so they never qualify.
- Hysteresis: `MIC_ENTER_FRAMES = 2` microphone frames in a row open a range, which starts at the first of them; `MIC_HANG_FRAMES = 6` non-microphone frames in a row (300 ms) or `MIC_OUTPUT_EXIT_FRAMES = 2` output frames in a row close it. A range ends at its last microphone frame: the hang bridges pauses between words, it never extends a range.
- Before smoothing, every word with at least `LOCAL_SPEAKER_MIN_SHARE = 0.5` of its span inside a range gets the local speaker, tagged by Sortformer or not; other words keep their tag. Smoothing then treats the local user like any speaker. Lines of the local user are written `[ You ]`.
- Live: each frame may carry its levels (`pushFrame(samples, rate, levels)`); they are recorded when the frame reaches the engine, so dropped frames shift neither timeline. The audio worker's `recording-frame` event carries them as optional `levels`, and the transcription controller hands them to `pushFrame`. Offline: `TranscriptionService` asks its `MicActivityReader` port (adapter `SidecarMicActivityReader`, the `TranscriptionRuntime` default) for the sidecar `<name>.mic.json` next to `<name>.wav` (`{"version":1,"ranges":[[startMs,endMs],...]}`, sorted, disjoint); an invalid or missing sidecar reads as a legacy recording.
- Used only while speaker labels actually run (setting on AND Sortformer model present): with labels off the transcript has no labels, `[ You ]` included. With no microphone, a muted one, or a legacy recording nothing changes.

Untimed windows (`FormatUntimedWindows`, safety net for no-word results): if `duration <= 30 s` one line. Else tokens by whitespace; `windowCount = min(ceil(duration / 30 s), tokens)`; if <= 1 one line; else window i gets tokens `[i*N/W, (i+1)*N/W)` (integer division) and time range `start + duration*i/W` to `start + duration*(i+1)/W`, with the last window ending exactly at `end`. Speaker tags are never emitted for untimed windows.

### 3.7 Stamp format (`TranscriptStampFormatter`)

- Header: `Recorded yyyy-MM-dd HH:mm`; end header `Ended yyyy-MM-dd HH:mm`; both converted `ToLocalTime()` and formatted with the invariant culture.
- Elapsed: `mm:ss.ff` with total minutes (not wrapped at 60: `125:03.20` is valid), seconds, and hundredths truncated (`milliseconds / 10`). Negative clamps to 0.
- Line: `[{elapsed(start)}-{elapsed(end)}] {text}`; with speaker tag > 0: `[{range}] [ Speaker-{n} ] {text}` (note the spaces inside the speaker brackets). `start < 0` clamps to 0; `end < start` becomes `start`.
- `EnsureEndedHeader(transcript, recordedAt, endedAt)`: returns the input unchanged if the transcript is null/empty or either timestamp is `default`. Newline style is CRLF if the text contains `\r\n`, else LF. If line 0 starts with `Recorded `: if line 1 starts with `Ended ` replace it, else insert `Ended ...` as line 1 (existing Recorded line kept as is). If line 0 is not a Recorded header, prepend `Recorded ...`, `Ended ...` then the original text. Idempotent.

### 3.8 Engine install policy (`TranscriptionEngineInstaller`) and runtime manager

- `IsReady` = model exists AND (CUDA runtime ready OR CPU runtime ready).
- `EnsureAsync(models, runtime, hardware, progress, ct)`, in order, each stage reporting `(StatusText, Percent)` with percent reset to 0 at stage start:
  1. If the preferred backend runtime is not ready: status `"Downloading NVIDIA CUDA runtime..."` or `"Downloading NVIDIA CPU runtime..."`, download it.
  2. If preferred is CUDA and the CPU runtime is not ready: `"Downloading NVIDIA CPU fallback runtime..."`, download CPU (CUDA create can still fail at load time).
  3. If the ASR model is not downloaded: `"Downloading Nemotron 3.5 ASR model..."`.
  The Sortformer model is never fetched here. These three status strings are hard-coded English literals, not resource keys.
- `ExpectedBackend(hardware, runtime)`: CUDA if preferred is CUDA and CUDA runtime ready; else CPU if CPU runtime ready; else the preferred backend.
- Runtime layout: `%LOCALAPPDATA%\MeetingLive\NemoSpeech\{cpu|cuda}\...\bin\nemo_speech_asr_c.dll`. `IsReady(backend)` is true when no `.incomplete` marker file `NemoSpeech\<folder>.incomplete` exists and the DLL is found at `<folder>\bin\<dll>` or recursively under any subdirectory (`<dir>\<dll>` or `<dir>\bin\<dll>`). `GetBinDirectory` throws `InvalidOperationException("The NeMo-Speech {backend} runtime is not installed.")` when not found.
- `DownloadRuntimeAsync(backend, progress, ct)`:
  1. Create the runtime directory. Download the pinned zip to `<folder>.zip` via the shared downloader (3.9).
  2. SHA-256 the zip (lowercase hex) and compare case-insensitively with the pinned value; mismatch throws `InvalidOperationException("NeMo-Speech {backend} zip SHA-256 mismatch (expected {expected}, got {actual}).")`.
  3. Delete any stale `<folder>.extracting`, `ZipFile.ExtractToDirectory` into `<folder>.extracting`.
  4. `InstallExtractedAsync`: write the `.incomplete` marker (covers the whole promote), promote the temp tree to `<folder>` (up to 8 attempts of delete-destination then `Directory.Move`, retrying on IO/access errors with `150 ms * (attempt+1)` backoff, because Defender scans often cause Access denied; after the last failure delete destination, copy the tree recursively, delete source), verify the DLL exists under the destination (else delete destination and throw `"NeMo-Speech {backend} zip extracted but nemo_speech_asr_c.dll was not found."`), then delete the marker. Any failure deletes the destination and rethrows, leaving the marker so the runtime reports not-ready.
  5. On any failure delete the `.extracting` temp dir; always delete the zip in `finally`.
- The marker is negative on purpose: older complete installs have none and stay ready.
- `DeleteRuntime()`: no-op if the root does not exist. First probe every file under the root by opening it `ReadWrite` with `FileShare.None`; a file that cannot be opened (IO or access error) throws `NemoSpeechRuntimeInUseException` ("The NeMo-Speech runtime file is in use: <name>") with NOTHING removed (files that vanished are ignored). Then, per backend that exists (CPU then CUDA): write the marker, delete the folder, delete the marker. Finally delete the root. A failure partway leaves that backend's marker so it is not ready; a retry finishes the job.
  Consequence: once the native library has been loaded in this process (any transcription or live session), the DLL is held open and delete always reports "in use" until the app restarts.
- `DeleteEngine(models, runtime)`: runtime first (it can refuse), then the ASR model file. Returns `Deleted`; `RuntimeInUse` on `NemoSpeechRuntimeInUseException` (model kept); `Incomplete` on any other `IOException`/`UnauthorizedAccessException` (including the model file being locked, after the runtime is already gone). The Sortformer model is not deleted (B6).

### 3.9 Downloads (`ResumableFileDownloader`, `NemotronModelManager`, catalog)

Pinned artifacts (`Core/S/NemotronAsrCatalog.cs`):
- ASR model: file `nemotron-3.5-asr-streaming-0.6b.q8_0.gguf`, display name `Nemotron 3.5 ASR Streaming 0.6B`, URL `https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/main/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf`, about 0.74 GB. Not SHA-verified.
- Sortformer: file `diar_streaming_sortformer_4spk-v2.q8_0.gguf`, URL `https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2/resolve/5240a64075176943f677d30fa2171c780229f341/diar_streaming_sortformer_4spk-v2.q8_0.gguf` (pinned commit), about 0.14 GB, documented sha256 `0679cfeb1ce356d0dea9470b31274f4bfc7eb927497d82005483770666da998a` (catalog documentation only, not verified).
- Runtime version `v0.1.0` (NVIDIA NeMo-Speech.cpp), DLL `nemo_speech_asr_c.dll`:
  - CPU: `https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-windows-x86_64-cpu.zip`, sha256 `5e4ea81046012edcd77fd8848de8eefb5a4ba38cc26f52eb544ab184695a75d6`.
  - CUDA: `https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-windows-x86_64-cuda.zip`, sha256 `ba024204e76ca2fa4eefa8787506c3c49e418147f627f60cf9206a582b60089c`.
  - Folder names `cpu` and `cuda`. "Latest" for the user means re-downloading these pinned files, not a floating build.

Downloader algorithm:
- GET with `ResponseHeadersRead`, `EnsureSuccessStatusCode`, stream into `<finalPath>.part` (created/truncated) in 81920-byte chunks. If `Content-Length` is known and > 0, report `totalRead * 100.0 / total` after each chunk (0-100 double). After the loop move the part file to `finalPath` with overwrite.
- On any exception (including cancellation) delete the `.part` file and rethrow, so the final path never holds a partial file.
- Despite its name there is no HTTP range resume: every attempt restarts from zero (B5). The shared HTTP client has an infinite timeout.
- `NemotronModelManager`: models directory `%LOCALAPPDATA%\MeetingLive\TranscriptionModels`; `IsModelDownloaded` / `IsDiarizationModelDownloaded` = file exists; delete is "if exists, delete" (throws on lock); downloads create the directory first.

### 3.10 Live service threading, backpressure and drop accounting

- Frames from the capture pump are enqueued to a bounded channel: capacity 8, drop-oldest, single reader and writer. The handler never waits on native code (the capture thread also writes the WAV).
- Per frame, `totalTicks += samples * 10^7 / sampleRate` (0 when the rate <= 0). When the channel drops the oldest frame, `droppedTicks += that frame's duration`. Counters reset at `Start`.
- A background worker reads frames. Under a lock it runs `Push` then `PullAvailable` and applies each result to the accumulator, then snapshots `DisplayText` and `CommittedText`. Exceptions from native calls are swallowed per frame (the recording must survive; a later frame or Stop may still produce text). The `TranscriptUpdated` event fires after releasing the lock, but only when a snapshot exists.
- `Start`: stops any running session first; maps language; creates the recognizer via the factory (live defaults, diarization flag); starts the stream (on failure disposes the recognizer and rethrows); creates the channel and accumulator; subscribes to `PcmFrameAvailable`.
- `Stop`: unsubscribe; complete the channel writer; wait for the worker (swallow `OperationCanceledException` and `ChannelClosedException`); if no session is running return `""`; else take stream/recognizer/accumulator, mark not running, call `CommitRemainingInterim` on the accumulator, dispose stream then recognizer (no `FinishAndDrain`), publish `LiveDropSummary(droppedTicks, totalTicks)` through `IAsrBackendStatus.ReportLiveDrops` (raises `LiveDropsChanged` exactly once per stopped session), return the committed text. `Dispose()` calls `Stop()`.
- `DroppedPercent = dropped / total * 100`, 0 when total <= 0.

### 3.11 Offline pass algorithm

`TranscribeAsync` throws immediately if already cancelled, then runs on a pool thread (cancellation token also passed to the task). Steps: create the recognizer with `enableSpeakerDiarization`, Meeting geometry and Offline latency; start a stream with the mapped locale; build an accumulator with `recordedAt ?? default`; repair WAV header; open with `AudioFileReader`; loop frames per 3.1 checking cancellation before each frame; push, pull all available results, apply, report percent. After the loop: `CommitRemainingInterim`, report 100, return `CommittedText`. In `finally` dispose the stream then the recognizer. Cancellation surfaces as `OperationCanceledException`. `TranscriptionProgress.ToPercent(position, duration)` = 0 when duration <= 0, else `round(100 * position / duration)` with away-from-zero rounding, clamped 0-100.

### 3.12 How the pipeline picks the transcript (consumer, for context)

`App/Services/RecordingPipelineOrchestrator.cs:60-125` and `Core/S/RecordingPipelineRules.cs:34-44`.
- If the engine `IsReady`: run the offline pass with `(audioPath, language, progress, ct, recordedAt, pausedDuration, SpeakerDiarizationEnabled)`. `OperationCanceledException` is rethrown; other exceptions are captured.
- `ResolveTranscriptionStage(liveDraft, offlineTranscript, offlinePassFailed)`: non-blank offline text wins (`OfflineTranscript`, then `EnsureEndedHeader` is applied); else blank-draft handling: non-blank draft gives `LiveDraftAfterFailure` if the pass failed or `LiveDraft` otherwise; no draft gives `FailedWithoutTranscript` if failed else `NoTranscript` (both save the meeting without a transcript and show the error strings in 2.4).
- If the engine is not ready and there is no draft: saved without transcript with `Error_EngineNotReady`.
- Highlights are applied to the final transcript with `TranscriptHighlightApplicator.Apply`.

### 3.13 Transcript helpers

`TranscriptHighlightApplicator` (`Core/S/TranscriptHighlightApplicator.cs`):
- `MarkerPrefix = "* "`. `FormatMarkLine(elapsed) = "* " + FormatElapsed(elapsed)`.
- `Apply(transcript, highlights)`: marks are clamped to >= 0, deduplicated, sorted. No marks: return transcript (or `""` when null). Empty transcript: marks as lines joined with `\n`. Newline style CRLF if present else LF; split on `\r\n` or `\n` only. Lines are indexed when (after stripping a leading `* `) they match `^\[(\d+):(\d{2}\.\d{2})-(\d+):(\d{2}\.\d{2})\]`. No stamped lines: append one mark line per mark after the existing lines. Otherwise for each mark pick the first line whose `[start, end]` contains the mark inclusive; else the last line whose start <= mark; else the first stamped line. Each target line is starred at most once and never double-prefixed (idempotent).

`TranscriptLineIndex`:
- `LineId(i) = "L" + i zero-padded to 3 digits` (`L000`, grows past 999). `Parse` returns non-empty trimmed lines (split on `\r\n` or `\n`), index = sequential among non-empty lines; whitespace/empty input gives none. `BuildTaggedDocument` joins `"{Id}| {Text}"` with `\n`. `MaxChoiceOptions = 255`. `TruncateToCompleteLines(lines, maxChars)`: empty or `maxChars <= 0` gives none; if the tagged document fits keep all; else keep leading whole lines while `length + piece + (1 if not first) <= maxChars`; if none fit keep the first line anyway. Used by `MeetingJevAsk`.

`CommittedTranscriptLine` (internal; used by `LiveAnswerWindow`, `LiveQuestionDetector`, `LiveQuestionJevJudge`, `MeetingSnippet`):
- `Split`: null/empty gives none; split on `\r\n`, `\n`, `\r`, keeping empty entries.
- `IsHeader(line)`: non-empty and (TrimStart) starts with `Recorded ` or `Ended ` (ordinal).
- Stamp read: the line must start with `[`; the stamp is the text up to the first `]` (position must be > 1). Range parse: split at the first `-` (not first or last char); each side is `m...m:ss.ff` where minutes has at least 2 digits (the colon index must be >= 2), seconds are exactly 2 digits and <= 59, hundredths exactly 2 digits, `.` exactly 3 chars after the colon, side length exactly dot+3. Value = minutes + seconds + hundredths*10 ms.
- `TryParseEnd`: the end of the range, false if the stamp is malformed.
- `ExtractBody`: empty gives `""`; no valid stamp gives `line.Trim()`; else the text after `]` with an optional ` [ Speaker-<digits> ] ` (or, in the port, ` [ You ] `) removed (requires a space before the closing `]`, at least one digit), trimmed.

`TranscriptionLanguageCatalog` and `InferenceCatalog` are static lists (see 2.7 and 3.15).

### 3.14 Transcript polish

Interface: `Task<string> PolishAsync(transcript, meetingLanguage = null, ct)`. Failure is non-fatal for the caller.

Prompt (`TranscriptPolishPromptBuilder.Build`, verbatim; `{languageName}` and `{transcript}` are substituted; indentation of the raw string literal is stripped):

```
# Identity

You polish an automatic-speech-recognition transcript. You fix writing, not content.

# Instructions

Return ONLY the polished transcript. No preamble, no code fences, no commentary.

Rules:
- Keep the "Recorded ..." and "Ended ..." headers (if present) and every [start-end] prefix byte-for-byte.
- Keep existing "[ Speaker-N ]" and "[ You ]" labels when present. Do not add, drop, or rename speakers.
- Only edit the spoken text after the stamp and speaker label.
- Fix punctuation, Spanish/English accents, truecasing, and well-known acronyms (ONU, NASA, FBI, UNESCO).
- Convert obvious questions to ¿? / ?.
- Represent a clear pause as `...` only when the transcript already implies one.
- Do not add speakers, action items, or a summary.
- Do not drop lines.
- Do not invent content that was not spoken.
- Write the spoken text in {languageName}.

# Transcript

<transcript>
{transcript}
</transcript>
```

Language name: trimmed lowercase code `es` Spanish, `en` English, `pt` Portuguese, `fr` French, `de` German, `it` Italian, `nl` Dutch, `ja` Japanese, `zh` Chinese; null, whitespace, `auto` or unknown gives Spanish.

Chunking (`SplitTimestampedChunks(transcript, maxChars)`): `maxChars <= 0` throws; empty or short input returns `[transcript]`; otherwise split on `\r\n`/`\n`, pack whole lines into chunks whose joined length (using `Environment.NewLine`, 2 chars on Windows) stays within the budget; a single over-long line becomes its own chunk. Chunks are joined back with `Environment.NewLine`.

Providers:
- Local (`LocalLlmTranscriptPolisher`): LLamaSharp, throws `FileNotFoundException("The selected local summary model has not been downloaded yet. Download it from Settings first.", path)` if the GGUF is absent. Loads weights once (semaphore guarded) with `ContextSize = 4096`. `ChunkMaxChars = 3500`. Per chunk: stateless executor with `ApplyTemplate = true`, `MaxTokens = 2048`, sampling temperature 0.2, prompt from the builder, tokens concatenated and trimmed; empty output throws `InvalidOperationException("The local model did not return any content.")`. Cancellation checked between chunks. `Dispose` frees the weights and the semaphore (safe when never loaded).
- Claude Code CLI: executable `claude`, arguments `CliInvocation.ClaudePrint(modelId, effort)`, timeout 5 minutes, prompt on stdin through `CliToolProviderBase.RunAsync`; failures map through `CliFailureMapper` (display name Claude Code). Not chunked.
- Codex CLI: executable `codex`, arguments `CliInvocation.CodexExec(modelId, effort)` (`codex exec -`), timeout 5 minutes. Not chunked.
- xAI: `session.GetAccessTokenAsync`, then `api.CompleteChatAsync(token, XaiApiClient.ResolveModelId(modelId, []), prompt, ct, reasoningEffort)`. Not chunked.
- Selection (`AppServices.CreateTranscriptPolisher`): Local requires a model path (else `ArgumentNullException`).

### 3.15 Inference catalog (used by settings, shared with summaries)

`InferenceCatalog`: `DefaultEffort = "low"`; Claude models `sonnet, opus, haiku, fable`, default `sonnet`; Claude efforts `low, medium, high, xhigh, max`; Codex models `gpt-5.4, gpt-5.5, gpt-5.6, gpt-5.6-sol`, default `gpt-5.6`; Codex efforts `low, medium, high, xhigh`; xAI efforts `none, low, medium, high, xhigh`. `AppSettings` falls back to these defaults when the stored id/effort is blank (`Core/M/AppSettings.cs:33-45`). Not live-benchmarked.

---

## 4. Persistence and wire formats

### 4.1 On-disk locations (Windows)

| Item | Path |
|---|---|
| ASR model, Sortformer model | `%LOCALAPPDATA%\MeetingLive\TranscriptionModels\` (file names in 3.9); `.part` sibling during download |
| Engine runtimes | `%LOCALAPPDATA%\MeetingLive\NemoSpeech\cpu\` and `...\cuda\`; transient `<folder>.zip`, `<folder>.extracting\`, `<folder>.incomplete` marker |
| Meeting transcript | stored inside the meeting markdown/record (other module) as the plain text format in 4.2 |
| Settings | `AppSettings` JSON: `TranscriptionLanguage` (string?, null means "es"), `LiveTranscriptionEnabled` (bool, default true), `SpeakerDiarizationEnabled` (bool, default false), plus provider/model/effort fields for polish and summaries |

The port must choose equivalent per-OS app-data locations; do not read the real user data directories during development.

### 4.2 Transcript text format

Lines separated by the platform newline when produced by the accumulator (CRLF on Windows); readers must accept `\r\n`, `\n` and (in `CommittedTranscriptLine`) `\r`.

```
Recorded 2026-11-02 14:05
Ended 2026-11-02 14:52
[00:00.00-00:04.32] [ Speaker-1 ] Good morning everyone, thanks for joining.
[00:04.80-00:09.10] [ Speaker-2 ] Thanks. Let's start with the roadmap.
[00:09.90-00:12.40] No speaker model, so no speaker label on this line.
* [00:30.00-00:41.55] [ Speaker-1 ] This line was starred by a highlight.
```

- Header lines are optional (`Recorded` is omitted when the recording time is unknown). `Ended` is added by the pipeline after the offline pass.
- Stamp: `[mm:ss.ff-mm:ss.ff]`, minutes may exceed 59 and have 2 or more digits.
- Speaker label: `[ Speaker-N ]` with N >= 1 (1-4 with Sortformer); absent when untagged; `[ You ]` for the local user (stored in English like the headers; pages show it in the UI language, `Ui_SpeakerYou`).
- A starred line has the literal prefix `* ` before the `[`. When a transcript has no stamped lines, highlight marks are appended as `* mm:ss.ff` lines.
- Live interim lines use the same format but are never persisted unless committed at Stop; an interim without word timings and without elapsed audio is a bare text line with no stamp.

### 4.3 Engine event payloads (in-process)

- `LiveTranscriptUpdate { DisplayText, CommittedText }`.
- `NemoSpeechAsrResult { IsFinal, Transcript, AudioProcessedSeconds, Words[] }`, `NemoSpeechWordTiming { Start, End, SpeakerTag, Text? }` (times in ms from the native API).
- `AsrBackendUsage { Backend: Cpu|Cuda, FallbackReason? }`; `LiveDropSummary { DroppedDuration, TotalDuration, DroppedPercent }`.
- `TranscriptionEngineInstallProgress { StatusText, Percent }`.
- `RetranscriptionResult { MeetingId, Outcome: Completed|TranscriptOnly|SummaryFailed|Cancelled|Failed, Message? }`.
- `RetranscriptionAvailability: Available|NoAudio|Busy`; `TranscriptionEngineDeletion: Deleted|RuntimeInUse|Incomplete`.

### 4.4 Remote wire

Only HTTPS downloads: Hugging Face (two GGUF files) and GitHub releases (two zips). No authentication. HTTP client timeout is infinite for these downloads. Polish providers use the CLI processes or the xAI chat API (see summary module).

---

## 5. Native and OS dependencies

### 5.1 Native engine

| Dependency | Platform | Notes |
|---|---|---|
| `nemo_speech_asr_c.dll` (NVIDIA NeMo-Speech.cpp v0.1.0, C ABI) | Windows-only as shipped (win-x86_64 zips). The library and model format (GGUF) are portable in principle; macOS needs a separate build, not shipped at v0.1.0 | Must be loaded once per process and never freed (3.5). CUDA variant needs an NVIDIA GPU and driver; CPU variant works anywhere x86_64 |
| NVIDIA Nemotron 3.5 ASR Streaming 0.6B q8_0 GGUF | Portable | Hugging Face download |
| Sortformer 4-speaker v2 q8_0 GGUF | Portable | Optional |
| P/Invoke structs with MSVC x64 layout | Windows x64 layout | Layouts must be recomputed per ABI when binding from another host; size asserts in tests |
| `SetDllDirectory` / `AddDllDirectory` | Windows-only | Equivalent on other OS is rpath or `DYLD_LIBRARY_PATH` |
| `HasNvidiaGpu` string match on GPU name | Windows hardware detection | Needs a cross-platform detector; macOS uses CPU or a Metal backend if one exists |

### 5.2 Managed libraries

| Dependency | Platform | Notes |
|---|---|---|
| NAudio `AudioFileReader`, `WavHeaderRepair` | Windows-only (NAudio uses Media Foundation for non-WAV; WAV reading itself is portable) | Port needs a WAV reader to float32, channel averaging, and the header repair |
| `System.IO.Compression.ZipFile`, SHA-256 | Portable | |
| `Directory.Move` retry and copy fallback, probing files with `FileShare.None` | Windows file locking semantics | On macOS/Linux open files can be deleted; the "in use" probe is unnecessary but a runtime that is loaded in-process should still refuse deletion until restart |
| LLamaSharp for the local polisher | Portable (native llama.cpp builds per OS) | Decision belongs to the local-inference module |
| CLI polishers (`claude`, `codex`) | Portable processes, PATH based | |
| WinUI `ContentDialog`, dispatcher queue | Windows-only | Replaced by renderer UI |
| `Environment.NewLine` in chunking and accumulator | Platform dependent (CRLF on Windows) | Port should normalize to `\n` internally and write the platform newline only at the persistence boundary, if the on-disk format must stay byte-compatible |
| Resource lookup (`AppStrings`, `CoreStrings`) | Portable concept | Keys in section 2 must exist in an i18n catalog for en and es |

### 5.3 Process-level constraints to preserve

1. Never call `stream_finish`; never unload the native library.
2. The audio capture callback must never block on ASR.
3. The ASR runtime is single-flight in practice: a live session and an offline pass use separate recognizers, and re-transcription shares the engine with the pipeline (the app gates it with `isBusy`).

### 5.4 Interfaces consumed from other modules

`IAudioCaptureService.PcmFrameAvailable`; `IHardwareDetectionService.DetectHardware()` returning `HardwareProfile.GpuName`; `AppSettings` / settings store; `RecordingPipelineOrchestrator`, `RecordingPipelineRequest`, `IRecordingPipelineCallbacks`; `IMeetingRepository`, `MeetingRecord`, `NoteTemplateInstructions`; `CliToolProviderBase`, `CliInvocation`, `CliFailureMapper`, `CliFailureUserMessage`; `XaiAuthSession`, `XaiApiClient`; `WavHeaderRepair`; `AppPaths`; `AppServices` composition root.

Consumers of this module's text helpers: `LiveAnswerWindow`, `LiveQuestionDetector`, `LiveQuestionJevJudge`, `MeetingSnippet`, `MeetingJevAsk`, `RecordingPageViewModel` (live display and highlight display), `RecordingPipelineOrchestrator`.

---

## 6. Existing test coverage (`MeetingLive.Core.Tests`)

Cases that must carry over to the port (names are xUnit method names):

- `Models/AsrLatencyProfileTests`: `RightContextFrames_MapsProfileToModelSupportedFrames` (Live 3, Offline 13), `RightContextFrames_EveryProfileIsAModelSupportedValue` (in {0,1,3,6,13}).
- `Native/NativeLibraryLoadCacheTests`: `GetOrLoad_WhenLoadFails_RetriesOnTheNextCall`, `GetOrLoad_WhenLoadSucceeds_KeepsTheLibraryForTheProcess`, `GetOrLoad_WhenCalledConcurrently_LoadsOnce`, `GetOrLoad_ForDifferentDirectories_NeverOverlaps`, `GetOrLoad_WhenAConcurrentLoadFails_TheWaitingCallerStillTries`.
- `Native/NemoSpeechNativeStructsTests`: `DiarConfig_MsVcX64Layout_Is40Bytes`, `EndpointingConfig_MsVcX64Layout_MatchesHeader`.
- `Services/LiveTranscriptionServiceTests`: `OnPcmFrame_WhenNativePushBlocks_DoesNotBlockTheCaller`, `Stop_ClosesStreamWithoutFinishAndDrain`, `TranscriptUpdated_RaisesCommittedTextSeparatelyFromDisplay`, `Stop_WhenNothingWasDropped_PublishesZeroPercent`, `Stop_WhenNativePushIsSlow_PublishesTheDroppedDuration`, `Stop_RaisesLiveDropsChangedOnce`, `Start_ResetsTheCountersOfThePreviousSession`.
- `Services/TranscriptionServiceTests`: `TranscribeAsync_PushesWavThroughStream_WithoutFinishAndDrain` (asserts locale `en-US`, Meeting geometry, Offline latency, one stream dispose, one recognizer dispose), `TranscribeAsync_WhenStreamYieldsNothing_ReturnsEmpty`, `TranscribeAsync_WavLeftOpenByAbruptExit_IsRepairedAndTranscribed`.
- `Services/StreamingTranscriptAccumulatorTests`: `Apply_Interim_ReplacesPartialSuffix`, `Apply_Final_CommitsTimestampedLine`, `Apply_ShortFinal_StaysOneLine`, `Apply_MixedSequence_CommitsFinalsAndReplacesInterim`, `DisplayText_AfterFinal_ShowsCommittedPlusCurrentInterim`, `Apply_FinalWithoutWords_UsesAudioProcessed`, `Apply_ClockSkew_DoesNotChangeElapsedRange`, `Apply_WhenRecordedAtIsDefault_OmitsClockAndHeader`, `Apply_LongFinal_SplitsIntoThirtySecondWindows`, `Apply_LongFinal_ExtraTokens_AppendToLastWindow`, `Apply_LongFinal_SingleToken_DoesNotSplitMidWord`, `Apply_SameSpeakerWithPause_SplitsIntoIdeaLines`, `Apply_SameSpeakerWithShortGap_StaysOneLine`, `Apply_SpeakerChange_SplitsLinesAndPreservesStamps`, `Apply_InterimWithWords_FormatsTimestampedDisplayWithoutCommitting`, `Apply_InterimWithWords_DoesNotAdvanceLastEndForNextFinal`, `CommitRemainingInterim_FormatsLeftoverWordsIntoCommittedLines`, `Apply_UntaggedWords_KeepsOldFormatWithoutSpeakerPrefix`, `Apply_SpeakerChange_WhenWordTextsMatchCount_UsesWordTexts`, `Apply_NoWordsInterimSpanning75Seconds_SplitsIntoWindowsOfAtMost30Seconds`, `Apply_NoWordsFinalSpanning75Seconds_SplitsIntoWindowsOfAtMost30Seconds`, `Apply_NoWordsFinalWithin30Seconds_StaysOneLine`.
- `Services/TranscriptStampFormatterTests`: `FormatHeader_UsesLocalRecordedStamp`, `FormatLine_WhenSpeakerTagIsZero_OmitsSpeakerBracket`, `FormatLine_WhenSpeakerTagIsPositive_IncludesSpeakerBracket`, `FormatLine_NegativeElapsed_ClampsToZero`, `FormatLine_WhenEndIsBeforeStart_UsesStartForEnd`, `FormatLine_WhenMinutesExceed59_KeepsTotalMinutes`, `FormatEnded_UsesLocalEndedStamp`, `EnsureEndedHeader_WhenRecordedHeaderExists_InsertsEndedAsSecondLine`, `EnsureEndedHeader_WhenEndedHeaderExists_ReplacesSecondLine`, `EnsureEndedHeader_WhenCalledTwice_DoesNotDuplicateEnded`, `EnsureEndedHeader_WhenTimestampsAreDefault_ReturnsTranscriptUnchanged`, `EnsureEndedHeader_WhenRecordedHeaderIsMissing_PrependsRecordedAndEnded`.
- `Services/TranscriptHighlightApplicatorTests`: `Apply_WhenNoHighlights_ReturnsTranscriptUnchanged`, `Apply_WhenTranscriptEmpty_WritesMarkLines`, `Apply_WhenMarkFallsInsideLine_PrefixesThatLine`, `Apply_WhenLineAlreadyMarked_DoesNotDoublePrefix`, `Apply_WhenMarkIsBetweenLines_StarsThePreviousLine`, `Apply_WhenTwoMarksHitTheSameLine_StarsOnce`.
- `Services/TranscriptLineIndexTests`: `Parse_NonEmptyLines_AssignsSequentialL000Ids`, `Parse_SkipsBlankLinesAndTrims_SplitsCrLf`, `Parse_WhenEmptyOrWhitespace_ReturnsNoLines`, `BuildTaggedDocument_PrefixesIdsWithPipe`.
- `Services/TranscriptionProgressTests`: `ToPercent_ClampsTo0Through100`.
- `Services/NemotronLanguageMapperTests`: `ToNemotronLocale_MapsKnownCodes`, `ToNemotronLocale_UnknownOrEmpty_ReturnsAuto`.
- `Services/NemotronAsrCatalogTests`: `MeetingGeometry_MatchesHuggingFaceVeryHighLatencyFrames`.
- `Services/NemotronModelManagerTests`: `GetModelPath_CombinesModelsDirectoryAndCatalogFileName`, `IsModelDownloaded_WhenFileMissing_ReturnsFalse`, `DownloadModelAsync_WritesResponseBytesToModelPath`, `DownloadModelAsync_WhenRequestFails_DoesNotLeaveAPartialFile`, `DeleteModel_WhenFileExists_RemovesIt`, `DeleteModel_WhenFileMissing_DoesNotThrow`, and the same six for the diarization model (`GetDiarizationModelPath_...`, `IsDiarizationModelDownloaded_...`, `DownloadDiarizationModelAsync_...`, `DeleteDiarizationModel_...`).
- `Services/ResumableFileDownloaderTests`: `DownloadAsync_WhileDownloadInProgress_HasCreatedThePartFileButNotTheFinalPath`, `DownloadAsync_OnCompletion_MovesThePartFileToFinalPathWithTheDownloadedContent`, `DownloadAsync_WhenCancelled_DeletesThePartialPartFileAndThrows`.
- `Services/NemoSpeechRecognizerFactoryTests`: `Create_WhenDiarizationDisabled_DoesNotRequireDiarModel`, `Create_WhenDiarizationEnabledAndFilePresent_PassesPath`, `Create_WhenDiarizationEnabledAndFileMissing_CreatesWithoutThrowing`, `Create_WhenMeetingGeometryAndDiarFilePresent_PassesMeetingToEngine`, `Create_DefaultGeometry_IsStreaming`, `Create_DefaultLatency_IsLive`, `Create_WhenOfflineLatency_PassesOfflineToEngine`, `Create_WhenCudaFallsBackToCpu_KeepsLatencyProfile`, `Create_WhenCudaSucceeds_ReportsCudaWithoutFallbackReason`, `Create_WhenCudaCreateThrows_FallsBackToCpuAndReportsReason`, `Create_WhenNoNvidiaGpu_ReportsCpuWithoutFallbackReason`, `Create_WhenCudaRuntimeMissing_ReportsCpuWithoutFallbackReason`, `Create_WhenStatusIsOmitted_StillCreatesRecognizer`, `Create_RaisesChangedWithTheNewUsage`.
- `Services/NemoSpeechRuntimeManagerTests`: `SelectBackend_WhenNvidiaGpu_ReturnsCuda`, `SelectBackend_WhenNoNvidiaGpu_ReturnsCpu`, `IsReady_WhenDummyDllMissing_ReturnsFalse`, `IsReady_WhenDummyDllExists_ReturnsTrue`, `DeleteRuntime_RemovesExtractedFiles`, `DeleteRuntime_WhenMissing_DoesNotThrow`, `IsReady_WhenAnInstallWasInterrupted_ReturnsFalse`, `IsReady_WhenAnotherBackendWasInterrupted_StaysTrue`, `InstallExtracted_WhenTheCopyFallbackFailsMidway_DoesNotReportReady`, `InstallExtracted_WhenTheCopyFallbackSucceeds_ReportsReady`, `InstallExtracted_OverAnInterruptedInstall_ReportsReady`, `InstallExtracted_WhenTheFolderHasNoNativeLibrary_ThrowsAndDoesNotReportReady`, `DeleteRuntime_WhenAFileIsHeldOpen_ThrowsAndRemovesNothing`, `DeleteRuntime_WhenTheLibraryIsReallyLoaded_ThrowsAndRemovesNothing`, `DeleteRuntime_WhenDeletionFailsPartway_DoesNotReportReady`, `DeleteRuntime_AfterAPartialDeletion_FinishesAndLeavesNoMarker`, `DeleteEngine_WhenTheRuntimeIsFree_RemovesBoth`, `DeleteEngine_WhenTheRuntimeIsInUse_KeepsTheModel`, `DeleteEngine_WhenTheRuntimeFailsPartway_KeepsTheModel`, `DeleteEngine_WhenTheModelIsLocked_ReportsIncomplete`.
- `Services/TranscriptionEngineInstallerTests`: `IsReady_WhenAsrAndRuntimeReadyButDiarMissing_ReturnsTrue`, `IsReady_WhenAsrAndRuntimeReady_ReturnsTrue`, `EnsureAsync_WhenDiarMissing_DoesNotDownloadSortformer`, `ExpectedBackend_WhenNvidiaGpuAndCudaRuntimeReady_ReturnsCuda`, `ExpectedBackend_WhenCudaRuntimeOnDiskButNoNvidiaGpu_ReturnsCpu`, `ExpectedBackend_WhenNvidiaGpuAndOnlyCpuRuntimeReady_ReturnsCpu`, `ExpectedBackend_WhenNothingInstalledAndNvidiaGpu_ReturnsCuda`.
- `Services/MeetingRetranscriptionTests`: `Evaluate_AudioExistsAndIdle_IsAvailable`, `Evaluate_AudioFileMissing_IsNoAudio`, `Evaluate_BlankAudioPath_IsNoAudioWithoutProbingTheDisk`, `Evaluate_NullRecord_IsNoAudio`, `Evaluate_AudioExistsButBusy_IsBusy`, `Evaluate_ChecksTheRecordedAudioPath`, `CreateRequest_DropsLiveDraftSoTheOfflinePassBecomesTheTranscript`, `CreateRequest_KeepsMeetingContextSoTheSavedRecordDoesNotLoseIt`, `CreateRequest_MissingEndedAt_UsesDefaultSoThePipelineTreatsItAsUnknown`.
- `Services/TranscriptPolishPromptBuilderTests`: `Build_InstructsModelToReturnOnlyPolishedTranscript`, `Build_WhenLanguageIsEnglish_AsksForEnglish`, `SplitTimestampedChunks_WhenShort_ReturnsSingleChunk`, `SplitTimestampedChunks_SplitsOnWholeLines`, `SplitTimestampedChunks_SingleLongLine_StaysOneChunk`.
- `Services/LocalLlmTranscriptPolisherTests`: `PolishAsync_WhenModelFileDoesNotExist_ThrowsFileNotFoundException`, `Dispose_WhenModelWasNeverLoaded_DoesNotThrow`.
- `Services/ClaudeCodeCliTranscriptPolisherTests`: `PolishAsync_OnSuccess_InvokesClaudeWithPrompt_AndReturnsStdout`, `PolishAsync_WhenNotLoggedIn_ThrowsCliToolExceptionNotSignedIn`, `PolishAsync_WhenStandardOutputIsEmpty_ThrowsCliToolExceptionEmptyOutput`, `PolishAsync_WhenLanguageIsEnglish_AsksForEnglish`.
- `Services/CodexCliTranscriptPolisherTests`: `PolishAsync_OnSuccess_InvokesCodexExecDash_AndReturnsStdout`, `PolishAsync_WhenNotLoggedIn_ThrowsCliToolExceptionNotSignedIn`.
- Indirect coverage of `CommittedTranscriptLine`: through `LiveQuestionDetectorTests`, `LiveAnswerWindowTests`, `MeetingSnippetTests`, `LiveQuestionJevJudgeTests`, `MeetingJevAskTests` (other modules).

Not covered by any test (the port should add tests): `AsrBackendStatus` / `LiveDropSummary.DroppedPercent`, `InferenceCatalog`, `TranscriptionLanguageCatalog`, `CommittedTranscriptLine` directly (stamp edge cases, speaker-tag stripping), `XaiTranscriptPolisher`, `TranscriptLineIndex.TruncateToCompleteLines`, the native wrapper (by design), `MeetingRetranscriptionRunner` outcome precedence, `TranscriptionEngineSectionViewModel` (live drops threshold, caption logic, delete outcomes), `TranscriptionEngineSetupDialogViewModel`, `TranscriptionEngineResolver`, `NemoSpeechRuntimeManager.DownloadRuntimeAsync` (SHA mismatch path), chunk-boundary behavior of the local polisher.

---

## 7. Bugs, races and uncovered cases

Status: confirmed = demonstrated by reading the code path with no assumption outside the repo; suspected = depends on runtime behavior or a caller I did not fully trace.

- B1 (confirmed) `ClockSkew` is dead. Set by `LiveTranscriptionService.SetClockSkew` (`Core/S/LiveTranscriptionService.cs:86-93`) and `TranscriptionService.cs:63`, declared at `Core/S/StreamingTranscriptAccumulator.cs:25`, never read anywhere. Stamps are elapsed-only (`TranscriptStampFormatter.FormatLine`), so there is no wall-clock to skew. The interface doc ("Adds pause duration to wall-clock stamps") describes behavior that does not exist; the test `Apply_ClockSkew_DoesNotChangeElapsedRange` pins the no-op. Port decision: drop it or implement wall-clock stamps deliberately. Also the offline pass is passed `pausedDuration` for the same unused purpose, while elapsed stamps follow WAV time (which excludes pauses only if capture does not write silence during pause; not verified).
- B2 (confirmed) Transcript polish is not wired. `AppServices.CreateTranscriptPolisher` (`App/Services/AppServices.cs:131`) has no callers outside its definition and no `PolishAsync` call exists in `App` or the pipeline (`rg PolishAsync` shows only the providers and tests). The feature, four providers and the prompt are shipped but unreachable; no setting enables them.
- B3 (confirmed) `auto` (and unknown) meeting language polishes in Spanish: `ToEnglishLanguageName` falls through to "Spanish" (`Core/S/TranscriptPolishPromptBuilder.cs:82-94`). An auto-detected English meeting would be rewritten into Spanish.
- B4 (confirmed) A throwing `TranscriptUpdated` subscriber faults the worker task: `TranscriptUpdated?.Invoke` at `LiveTranscriptionService.cs:198` is outside the per-frame try/catch, and the outer catch handles only `ChannelClosedException`. `Stop()` then rethrows from `worker.GetAwaiter().GetResult()` (`:107`; the filter at `:109` excludes other exceptions) before the lock section at `:118`, so `_running` stays true and the native stream and recognizer are never disposed. The handler in the app only enqueues to the dispatcher so it does not throw today; a port must guard the emit.
- B5 (confirmed) The downloader is not resumable and has no integrity checks beyond the zip SHA: `ResumableFileDownloader.cs:33` truncates the part file on every attempt; the GGUF files are not hashed (`NemotronAsrCatalog.cs:21-23` says so); and a truncated body is accepted when no `Content-Length` is given (chunked response). The shared client is created with `Timeout.InfiniteTimeSpan` (`App/Services/AppServices.cs:14-16`), so a stalled connection hangs the dialog until the user cancels.
- B6 (confirmed) `DeleteEngine` does not delete the Sortformer model (`Core/S/NemoSpeechRuntimeManager.cs:105-121`), so "Delete" leaves about 0.14 GB behind and `IsSpeakerDiarizationModelInstalled` stays true.
- B7 (confirmed) Speaker labels silently degrade. The factory skips diarization when the file is missing (`Core/S/NemoSpeechRecognizerFactory.cs:25-27`, covered by `Create_WhenDiarizationEnabledAndFileMissing_CreatesWithoutThrowing`), while the settings toggle persists `SpeakerDiarizationEnabled=true` before the download and keeps it true if the download fails (`App/ViewModels/TranscriptionEngineSectionViewModel.cs:229-238`). Deleting the model (`:275-280`) also leaves the setting on. The user sees "Speaker labels: on" and gets untagged transcripts with no warning.
- B8 (confirmed) Re-transcription drops highlights: `CreateRequest` passes `Highlights: []` (`Core/S/MeetingRetranscription.cs:48`), and `PausedDuration` is zero, so previously starred lines in the old transcript are not re-applied to the new one.
- B9 (confirmed) `INemoSpeechRecognizer.Recognize` / `NemoSpeechNativeLibrary.RecognizeF32` are dead code: nothing calls `.Recognize(` outside implementations. `FinishAndDrain` is intentionally unused. The port can omit both.
- B10 (suspected) Chinese and Japanese segmentation. `ResolveTokens` splits on whitespace (`StreamingTranscriptAccumulator.cs:242-249`). For `ja`/`zh` the text has no spaces, so when the engine returns N word timings but the split yields 1 token the counts differ, `tokens=[whole text]`, `pairCount=1`, and the 30 s, speaker and idea-pause splitting is skipped: the whole utterance lands in the first window with the first word's speaker, and later words' timings are ignored (`:151-186`). Same mismatch can happen for any language when the engine's punctuation attachment differs from word timings.
- B11 (suspected) UI thread can stall on resume: `SetClockSkew` takes `_gate` (`LiveTranscriptionService.cs:86-93`) while the worker holds the same gate during native `Push`/`PullAvailable` (`:176-187`), which can take hundreds of ms on CPU. It is called from the resume handler (`RecordingPageViewModel.cs:1509`) which is not shown to be off-thread. Moot if B1 is fixed by removing it.
- B12 (suspected) Race around Start/Stop from different threads: `Start` assigns `_frameWriter` and `_worker` outside `_gate` (`:81-82`) after `_running = true` is published (`:73-79`); `Stop` reads them with `Interlocked` but a concurrent `Start`+`Stop` could observe `_running` true with a null worker. The app serializes calls, so this is latent.
- B13 (suspected) Progress flood: the offline loop reports a percent for every 100 ms frame (`TranscriptionService.cs:84`) and the pipeline dispatches a UI update each time with no de-duplication, up to 36 000 callbacks per hour of audio even though only 101 distinct values exist.
- B14 (suspected) Starred lines defeat the line parser: `CommittedTranscriptLine.TryReadStamp` requires `[` at index 0 (`:56`), so a line prefixed `* ` (added by `TranscriptHighlightApplicator`) returns `line.Trim()` from `ExtractBody` including the stamp text. `MeetingSnippet.TranscriptBody` (`Core/S/MeetingSnippet.cs:54-59`) would show `* [00:30.00-00:41.55] ...` for highlighted lines in saved transcripts. Live paths read the un-starred live text, so they are unaffected.
- B15 (suspected) Local polish overflow: `ChunkMaxChars = 3500` is a character budget against a 4096-token context with a 2048-token output cap (`LocalLlmTranscriptPolisher.cs:16,66,95`). For CJK text one character is about one token or more, so prompt plus chunk can exceed the context; for long Latin chunks the 2048-token cap can truncate output silently with no check that line counts match.
- B16 (suspected) Polish output is not validated and the prompt is injectable: no check that the model preserved every line, stamp and speaker label, no stripping of code fences despite the instruction, and a transcript containing `</transcript>` ends the data block early (`TranscriptPolishPromptBuilder.cs:37-39`). CLI and xAI polishers send the whole transcript unchunked.
- B17 (suspected) Concurrent installs collide: the Settings download and the Record gate dialog can both call `DownloadRuntimeAsync` / `DownloadModelAsync`; they share `<folder>.zip`, `<folder>.extracting` and `<model>.part` paths with no lock (`NemoSpeechRuntimeManager.cs:40-42`, `ResumableFileDownloader.cs:23`). One's failure cleanup can delete the other's files.
- B18 (suspected) Interim line without stamp can be committed: an interim with no words and `AudioProcessedSeconds <= _lastEnd` yields bare text (`StreamingTranscriptAccumulator.cs:119-122`); `CommitRemainingInterim` copies those lines into committed text, producing an unstamped line inside a stamped transcript that `CommittedTranscriptLine` treats as body-only and `TranscriptHighlightApplicator` cannot place.
- B19 (suspected) Inconsistent line splitting: `CommittedTranscriptLine.Split` also splits on lone `\r`; `TranscriptLineIndex.Parse`, `TranscriptHighlightApplicator.Apply`, `TranscriptStampFormatter.EnsureEndedHeader` and `SplitTimestampedChunks` split on `\r\n` and `\n` only. `TranscriptHighlightApplicator.ParseElapsed` uses `int.Parse` on `\d+` minutes (`:93-98`), which throws on more than 10 digits.
- B20 (suspected) `EnsureEndedHeader` only detects `Ended` on line 1 when line 0 starts with `Recorded`. A transcript that already begins with an `Ended` line but no `Recorded` line gets a second pair of headers prepended (`TranscriptStampFormatter.cs:54`).
- B21 (suspected) Install progress is shown three times from 0 to 100 (CUDA runtime, CPU fallback runtime, model) in one dialog with a single bar (`TranscriptionEngineInstaller.cs:25-55`); there is no overall percent, and an error mid-way leaves earlier stages installed, which is reflected only on the next `IsReady` check.
- B22 (suspected) `DeleteSpeakerDiarizationModel` has no exception handling (`TranscriptionEngineSectionViewModel.cs:275-280`); if the live recognizer has the file mapped, `File.Delete` throws `IOException` on Windows and the command faults without a message. `DeleteIfExists` in `NemotronModelManager.cs:50-55` also throws.
- B23 (suspected) `HasNvidiaGpu` depends on a single `GpuName` string; on hybrid laptops where the detector returns the integrated GPU first, CUDA is never chosen (`HardwareProfile.cs:12-21`; detection logic belongs to the hardware module).
- B24 (confirmed, cosmetic) Source docs: `AsrBackendStatus.cs:12-18` has two stacked `<summary>` blocks (the first describes the interface and is orphaned); `ITranscriptPolisher`, `TranscriptionProgress` and the three polisher files have mis-indented XML docs/classes. No behavior impact.
- B25 (confirmed, gap) User-visible English literals bypass localization: the three installer status strings (`TranscriptionEngineInstaller.cs:28-30,43,51`) and exception messages used as UI text (`ErrorText = ex.Message`, fallback reason) are not translated.

---

## 8. Parity checklist

Tick each item when the Electron implementation reproduces it. Items that map to a known bug state the intended decision in brackets.

Engine gate and setup dialog
1. Record is blocked until `IsReady` (model exists AND (CUDA or CPU runtime ready)); diarization model is not part of readiness.
2. If not ready, a modal setup dialog appears; its result decides whether recording may start; Cancel or failure returns false.
3. Dialog title "Download transcription engine"; single button "Cancel"; hint text with 0.74 GB wording; progress bar 0-100; status line; error bar titled "Download failed".
4. Download starts automatically when the dialog opens; initial status "Preparing download...".
5. Progress text format is `"{status}  {percent:0}%"` with two spaces.
6. After install, readiness is re-verified; not ready shows "Download finished but the transcription engine is still not ready." and keeps the dialog open.
7. Cancel cancels the download token and swallows the cancellation silently.
8. Other failures show the raw error message in the error bar and the status "Download failed."; dialog stays open.

Live transcription
9. `LiveTranscriptionEnabled` (default true) gates the live pass; when off only the offline pass runs.
10. Status "Loading transcription model..." is shown while the live recognizer starts; start failure surfaces `Error_StartRecording` and stops the live session.
11. Live frames are 16 kHz mono float32 from the capture tap.
12. Frames are queued in a bounded queue of 8 with drop-oldest; the capture callback never blocks on ASR.
13. Total and dropped audio durations are tracked per session and reset at Start.
14. Native Push and PullAvailable errors on a frame are swallowed; the session continues.
15. `TranscriptUpdated(display, committed)` fires off the lock after each applied frame; the emit must be guarded against subscriber exceptions [fix B4].
16. `Start` stops any running session first; if stream creation fails the recognizer is disposed and the error rethrown.
17. `Stop` unsubscribes, drains the worker, commits remaining interim, disposes stream then recognizer, never calls `stream_finish`.
18. `Stop` returns committed text (empty when not running) and publishes the drop summary exactly once per stopped session.
19. If `Stop` throws, the recording page falls back to the on-screen live text as the draft.
20. `SetClockSkew` exists on the API [decide: remove or implement; B1].
21. Display text is committed lines plus the rewritten interim suffix; committed text is finals only.

Accumulator and format
22. Finals append committed lines; interims replace the single interim buffer; a final (even empty) clears the interim.
23. `Recorded yyyy-MM-dd HH:mm` (local) header is written once before the first committed line when the recording time is known; absent when unknown.
24. DisplayText with no committed lines prepends the header to the interim when the time is known.
25. `CommitRemainingInterim` splits interim on newlines, drops empties, adds the header if missing.
26. Timing for word-bearing results is first word start to last word end.
27. For no-word results: start = last committed end, end = `AudioProcessedSeconds` clamped >= start; an interim with zero span is emitted as bare text.
28. `_lastEnd` advances on finals only.
29. Single-line fast path when span <= 30 s, one speaker tag, and no gap >= 500 ms.
30. Window split rules: speaker change, `word.End - windowStart >= 30 s`, inter-word gap >= 500 ms.
31. Tokens are the engine word texts when counts match and all non-null, else whitespace tokens; extra tokens are appended to the last window [consider fix for B10].
32. Window line text is tokens joined by single spaces; empty windows skipped.
33. No-word windows: split into `min(ceil(duration/30 s), tokens)` windows by even token distribution with proportional time; last window ends exactly at `end`; never carries speaker tags.
34. Line format `[mm:ss.ff-mm:ss.ff] text`, with `[ Speaker-N ] ` inserted when the tag > 0.
35. Elapsed formatting: total minutes (not wrapped), seconds, hundredths truncated, negative clamps to zero.
36. `end < start` is coerced to `start`; `start < 0` to 0.
37. `EnsureEndedHeader` rules: no-op for empty/default inputs; replace line 1 if it starts with `Ended `; insert after the Recorded line; prepend both when no Recorded line; keeps CRLF vs LF; idempotent.
38. Accumulated text uses the platform newline; readers accept CRLF, LF and (for the committed-line parser) CR.

Language
39. Catalog order auto, en, es, pt, fr, de, it, nl, ja, zh with en and es display names.
40. Summary language catalog es then en, separate setting.
41. Unset transcription language resolves to `es`; selection persists the code; unknown stored code selects index 0.
42. Locale mapping table exactly as in 3.2, unknown or blank gives `auto`.

Offline pass
43. Recognizer is created with Offline latency (13 frames) and Meeting geometry; locale from mapper; diarization per setting.
44. WAV header is repaired before reading; zero-size RIFF/data headers from crashed recordings must be readable.
45. Audio is read in 100 ms frames; multichannel is averaged to mono; actual sample rate is sent; empty frames skipped.
46. Cancellation is checked per frame and surfaces as a cancellation error; stream and recognizer are always disposed.
47. Progress is `round-half-away(100*pos/duration)` clamped 0-100; a final 100 is reported after the loop; zero duration gives 0 [throttle updates; B13].
48. Remaining interim is committed at the end and the committed text is returned.
49. Pipeline stage rules: offline text wins; else draft (with warning if pass failed); else error outcomes; `Ended` header applied to offline text; highlights applied afterward.
50. Engine not ready and no draft saves the meeting without transcript and shows `Error_EngineNotReady`.
51. User strings for the four pipeline outcomes match 2.4 (en and es).

Re-transcription
52. Availability: NoAudio for null record, blank path, or missing file (in that order), then Busy, then Available.
53. Request construction copies the fields listed in 2.5, `LiveDraft` null, `PausedDuration` zero, `EndedAt ?? default` [decide on highlights; B8].
54. Only one re-transcription at a time; `StartAsync` returns false if running.
55. Runner status text starts "Transcribing audio..." and follows pipeline status callbacks.
56. Meeting-saved callback notifies the workspace so other views refresh.
57. Outcome precedence SummaryFailed > Failed > Completed > Cancelled > TranscriptOnly; message only for the first two.
58. Cancel before the pipeline starts leaves everything untouched; the previous transcript stays until the offline pass succeeds.
59. Terminal state resets `IsRunning`, `MeetingId`, `Status` before raising `Finished`.
60. Session page confirmation and result strings as in 2.5 (en and es).

Backend selection and status
61. `SelectBackend`: CUDA iff GPU name contains NVIDIA, GeForce, Quadro or Tesla (case-insensitive).
62. CUDA is tried only if preferred AND the CUDA runtime is ready, with `gpu=0`; CPU uses `gpu=-1`.
63. CUDA create failure falls back to CPU, preserving geometry and latency, and records the exception message as `FallbackReason`.
64. No CUDA preference or missing CUDA runtime gives Cpu with no fallback reason.
65. Missing ASR model throws "The Nemotron ASR model is not installed."; missing CPU runtime throws "The Nemotron ASR CPU runtime is not installed."
66. Diarization enabled but file absent creates the recognizer without diarization [add a user-visible warning; B7].
67. `IAsrBackendStatus` stores the last backend usage and last live-drop summary and raises events; values are null until first report.
68. `DroppedPercent = dropped/total*100`, 0 when total is zero.

Settings UI
69. Live transcription toggle persists `LiveTranscriptionEnabled` and is a no-op when unchanged.
70. Speaker labels toggle persists and, when turning on without the model, downloads it immediately.
71. Sortformer download: status "Downloading Sortformer speaker model...", progress text `"{status}  {pct:0}%"`, installed flag from disk, failure text `"Download failed: {0}"` stays visible.
72. Sortformer delete removes the file and clears the installed flag (and should handle errors) [B22].
73. Engine download: status "Starting download...", progress text format, success refreshes installed flag and expected backend, failure writes "Download failed: {0}" to the acceleration caption, always resets progress.
74. Engine delete: runtime first, then model; `Deleted`/`RuntimeInUse`/`Incomplete` outcomes with the two error strings; status refresh happens before the caption override.
75. Acceleration caption states: expected CUDA, expected CPU, active CUDA, active CPU with exact strings.
76. Fallback warning with title "GPU acceleration is not active" and reason text.
77. Live-drop caption "Last live session: {0}% of audio skipped" with percent in `0.#` culture format; warning "Live transcript skipped audio" when strictly above 5%.
78. Backend status observation only while Settings is visible; handlers marshal to the UI thread.
79. Delete should also remove the Sortformer model [B6].

Runtime install and delete
80. Runtime URLs, versions and SHA-256 values exactly as pinned in 3.9; SHA compared case-insensitively against lowercase hex; mismatch error text exact.
81. Zip downloads to `<folder>.zip`, extracts to `<folder>.extracting`, promotes to `<folder>`; temp and zip cleaned in all outcomes.
82. Promote retries 8 times with `150 ms * (n+1)` backoff, then falls back to copy; a `.incomplete` marker covers the whole promote.
83. Not-ready conditions: marker present, or DLL not found under the folder (direct `bin`, nested `bin`, or any subfolder).
84. Failed promote or missing DLL deletes the destination and leaves the marker; an interrupted older install without a marker stays ready.
85. `DeleteRuntime`: probe-all-files first; any held file throws "in use" with nothing removed; otherwise per-backend marker, delete, unmarker; then delete the root; failure partway leaves a marker so the backend is not ready; retry completes.
86. The native library stays loaded for the process lifetime, so delete after any transcription reports in use until restart.
87. Installer order: preferred runtime, CPU fallback runtime (when CUDA preferred), then ASR model; status strings exact [localize; B25].
88. `ExpectedBackend` rules per 3.8.
89. The installer never downloads the Sortformer model.

Model and downloader
90. Model and diarization file names, URLs (Sortformer pinned at the commit hash), and directories as in 3.9.
91. Download writes to `.part` and atomically moves into place on success; any failure or cancellation deletes the `.part` file and never leaves a file at the final path.
92. Progress is a 0-100 double reported only when `Content-Length` is known and > 0; 80 KiB chunks.
93. `IsModelDownloaded` is file existence; delete tolerates a missing file.
94. Add range-resume, stall timeout and checksum verification for the GGUF files [B5].
95. Runtime and model downloads must not run concurrently on the same paths [B17].

Native binding
96. Config values: chunk 0.16, CTC padding 1.92/1.92, RNNT right context 6 or 13, endpointing enabled energy-based with 800 ms, word offsets and automatic punctuation on, verbatim and profanity off, max alternatives 1, max speakers 0.
97. Diarization geometry values exactly as in 3.3 (Meeting: 340/40/-1/40/188/300; Streaming: 0 except left -1).
98. Native results are read fully (transcript alt 0, final flag, audio processed seconds, words with start ms, end ms, speaker tag, text) and destroyed immediately.
99. Native failure statuses throw with the library's last error text.
100. Library loads are cached per directory, serialized, retried after failure, never freed; DLL search path is set before load.
101. Struct sizes and offsets verified by tests on the target ABI.
102. Never call stream finish; never unload the library.

Transcript helpers
103. Highlight starring: clamp, dedupe, sort marks; inclusive range match, else previous line, else first; idempotent; mark lines when no stamped lines; CRLF/LF preserved.
104. Starred lines are recognized by the stamp regex after stripping the `* ` prefix.
105. Line index ids `L###`, non-empty trimmed lines, tagged document `"Lnnn| text"` joined by `\n`, max 255 options, truncation keeps whole lines and at least the first.
106. Committed-line parser: header detection, strict stamp grammar, end-time parsing, speaker-tag stripping, body extraction; starred lines [decide handling; B14].

Polish
107. Prompt text is byte-identical to section 3.14 with the language name and transcript substituted.
108. Language names map as listed, default Spanish [fix for auto; B3].
109. Chunker packs whole lines within the budget; an over-long single line is its own chunk; short input is one chunk; non-positive budget throws.
110. Local provider: missing model throws the exact message; one load guarded by a semaphore; context 4096; chunk budget 3500; max tokens 2048; temperature 0.2; empty output throws; cancellation between chunks.
111. Claude Code and Codex providers use the 5-minute timeout, stdin prompt, the exact argument builders, and the CLI failure mapping (not signed in, empty output).
112. xAI provider resolves a model id and passes the reasoning effort.
113. Provider selection mirrors the summary provider kind; Local requires a model path.
114. Polish failure keeps the raw transcript [and the feature must actually be invoked; B2].

Catalogs
115. Inference catalog lists and defaults as in 3.15, with settings falling back to defaults on blank values.
116. Resource keys listed in section 2 exist for both en and es.
