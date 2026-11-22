import type { CancelSignal } from '../cancel';
import { CancelSource } from '../cancel';
import type { Clock } from '../clock';
import type { TranslateFn } from '../i18n/translator';
import type { Logger } from '../logging';
import { packProjectContext, projectBudgetFor } from '../projects/project-context';
import type { ProjectContextSource, Result } from '../projects/ports';
import { isRemoteEngine } from '../settings/api-providers';
import { isCliEngine, readsImagesFromDisk } from '../settings/cli-providers';
import type { CliPromptOptions } from '../summaries/cli-provider';
import type { ModelChoice } from '../summaries/model-choice';
import type { ProviderId } from '../summaries/provider';
import type { SetupKind } from '../summaries/provider-resolver';
import {
  attachmentBudgetFor,
  packAttachments,
  type ChatAttachmentSource,
  type ResolvedAttachments,
  type StagedImages,
} from './attachments';
import {
  emptyAnswerFailure,
  isCancellation,
  providerRemovedFailure,
  scopeGoneFailure,
  sendFailedFailure,
  setupCancelledFailure,
  type ChatFailure,
} from './chat-errors';
import type {
  ChatThread,
  ChatThreadRepository,
  ChatThreadSummary,
  ThreadOwner,
  ThreadScope,
  ThreadScopeStatus,
} from './chat-thread';
import {
  carveProjectBlock,
  contextBudgetFor,
  packContextWithCoverage,
  singleLine,
  type ContextMeeting,
  type ContextProject,
  type LiveContextSnapshot,
  type MeetingCoverage,
} from './context-packer';
import { answerLanguageName, buildPrompt, priorTurnLimitsFor } from './prompt-builder';
import { matchesOpenThread, type ChatScopeDecision } from './scope-resolver';
import { StreamCoalescer } from './stream-coalescer';
import { cutPrefix } from '../text/utf16-cut';
import type { ChatEngine } from './user-prompts';

/**
 * Core ports for chat. Each query is scoped by id or project, so a send never loads every
 * meeting just to answer about one.
 */
export interface ChatMeetingReader {
  meetingById(id: string): Promise<ContextMeeting | null>;
  /**
   * `question` lets the reader read the meetings that match it in full (marked with
   * `relevanceRank`) before the newest ones.
   */
  meetingsInProject(projectId: string, question?: string): Promise<readonly ContextMeeting[]>;
  /** Every meeting, in any order: the packer sorts and caps. Same `question` rule. */
  listRecent(question?: string): Promise<readonly ContextMeeting[]>;
  listProjects(): Promise<readonly ContextProject[]>;
}

/** What chat passes with a prompt: the shared options plus the images of the send. */
export type ChatPromptOptions = CliPromptOptions;

/** The slice of `SummaryProvider` chat uses. */
export interface ChatStreamProvider {
  /** Sizes the packed context. Unset is treated as the local engine, the smallest budget. */
  readonly id?: ProviderId;
  /** Engines that cannot take images ignore `options.images`; chat only sends them to CLIs. */
  streamPrompt(
    prompt: string,
    cancel: CancelSignal,
    options?: ChatPromptOptions,
  ): AsyncIterable<string>;
}

/** Mirrors `ProviderResolution`: ready, needs a gate, or removed. */
export type ChatProviderResolution =
  | { readonly status: 'ready'; readonly provider: ChatStreamProvider }
  | { readonly status: 'needs-setup'; readonly kind: SetupKind }
  | { readonly status: 'unavailable' };

export interface ProviderSource {
  /**
   * `engine` is the engine for this send only (a saved prompt's, or the model picker's); unset uses
   * the one from Settings. `choice` is the picker's model and effort, only ever with an engine.
   */
  resolve(engine?: ChatEngine, choice?: ModelChoice): Promise<ChatProviderResolution>;
}

/**
 * Runs the existing setup gate (model download, CLI check). Returns the ready provider, or null
 * when the user cancelled it.
 */
export type SetupGate = (kind: SetupKind) => Promise<ChatStreamProvider | null>;

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly createdAt: Date;
}

/** The saved side of a conversation. The owner is fixed when the thread is created. */
interface OpenThread {
  readonly id: string;
  readonly owner: ThreadOwner;
  readonly title: string;
  /** ISO-8601 UTC, kept from the first turn. */
  readonly createdAt: string;
  /** False until a save succeeded; a later turn saves the whole thread again. */
  readonly saved: boolean;
}

interface Conversation {
  readonly scope: ChatScopeDecision;
  readonly messages: readonly ChatMessage[];
  /** Null until the first successful turn (or when there is no thread repository). */
  readonly thread: OpenThread | null;
  /** Set when a reopened thread's meeting or Live take is gone: it cannot take a new question. */
  readonly scopeStatus: ThreadScopeStatus;
  /** False after a failed save, true again once a save succeeds. */
  readonly historySaved: boolean;
}

/** The turn being answered: the user row and the pending assistant row. */
export interface PendingTurn {
  readonly userText: string;
  readonly assistantText: string;
}

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly isSending: boolean;
  readonly pending: PendingTurn | null;
  /** Recomputed from the current scope, also while sending. */
  readonly showScopeMismatch: boolean;
  readonly hasMessages: boolean;
  /** New chat is off while sending. */
  readonly canStartNewChat: boolean;
  /** The saved thread this conversation writes to; null until its first turn is saved. */
  readonly threadId: string | null;
  /** False when the last save failed: the chat goes on in memory only. */
  readonly historySaved: boolean;
}

/** What `openThread` answers: the thread to show, or why it cannot be opened. */
export type OpenThreadOutcome =
  | {
      readonly ok: true;
      readonly thread: {
        readonly id: string;
        readonly title: string;
        readonly scope: ThreadScope;
        readonly messages: readonly ChatMessage[];
        readonly scopeStatus: ThreadScopeStatus;
      };
    }
  | { readonly ok: false; readonly reason: 'busy' | 'not-found' | 'corrupt' };

/** The most characters of a thread title taken from the first message. */
export const THREAD_TITLE_MAX = 60;

/** The first user message on one line, cut at `THREAD_TITLE_MAX`. */
export function threadTitleOf(text: string): string {
  return cutPrefix(singleLine(text).replace(/\s+/g, ' ').trim(), THREAD_TITLE_MAX).trimEnd();
}

const isoOf = (date: Date): string => date.toISOString();

/** A renamed title may be longer than the one cut from a message; the contract allows 200. */
const THREAD_TITLE_RENAME_MAX = 200;

/** What packing the context tells the send besides the text. */
interface PackedContext {
  readonly text: string;
  /** The project that owns the conversation; null for no project. */
  readonly owner: ThreadOwner;
  /** The scope names a meeting that no longer exists. */
  readonly meetingGone: boolean;
  /** Project and All meetings: how many meetings the context carries, of how many matched. */
  readonly coverage: MeetingCoverage | null;
}

export type ChatSendOutcome =
  | { readonly status: 'ignored' }
  | {
      readonly status: 'sent';
      readonly user: ChatMessage;
      readonly assistant: ChatMessage;
      /** A line to show next to the answer (images the local engine left out), or null. */
      readonly notice: string | null;
      /**
       * Project and All meetings: how many meetings the answer was based on, of how many matched.
       * Absent for one meeting or a live take.
       */
      readonly coverage?: MeetingCoverage;
    }
  /** The user stopped the answer. Silent: no message, nothing kept. */
  | { readonly status: 'cancelled'; readonly originalDraft: string }
  /** No gate was given: the caller runs it and sends again. */
  | {
      readonly status: 'setup-required';
      readonly kind: SetupKind;
      readonly originalDraft: string;
    }
  | { readonly status: 'failed'; readonly failure: ChatFailure; readonly originalDraft: string };

export interface ChatServiceDeps {
  readonly meetings: ChatMeetingReader;
  readonly providers: ProviderSource;
  readonly clock: Clock;
  readonly translate: TranslateFn;
  readonly newId: () => string;
  /** Optional: gets one timing line per answer (time to first chunk, total). */
  readonly logger?: Logger;
  /** UI language tag (`es`, `en-US`), read on every send: the fallback answer language. */
  readonly uiLanguage?: () => string;
  /** Files attached to the conversation. Unset: sends never carry files. */
  readonly attachments?: ChatAttachmentSource;
  /** Saved conversations. Unset: the chat lives in memory only and nothing is listed. */
  readonly threads?: ChatThreadRepository;
  /** The instructions and files of a project. Unset: no chat has a project block. */
  readonly projects?: ProjectContextSource;
}

export interface SendOptions {
  readonly setupGate?: SetupGate;
  /** Attachment ids the page holds for this conversation; only ready ones are used. */
  readonly attachmentIds?: readonly string[];
  /** A saved prompt's engine (Phase 5). Used for this send only, with the usual setup outcomes. */
  readonly engine?: ChatEngine;
  /** The model picker's model for `engine`, this send only. Ignored without an engine. */
  readonly model?: string;
  /** The model picker's effort for `engine`, this send only. Ignored without an engine. */
  readonly effort?: string;
}

/** The picker's model and effort, or undefined when the send names neither. */
const choiceOf = (options: SendOptions): ModelChoice | undefined => {
  const choice: { model?: string; effort?: string } = {};
  if (options.model !== undefined) choice.model = options.model;
  if (options.effort !== undefined) choice.effort = options.effort;
  return Object.keys(choice).length === 0 ? undefined : choice;
};

const NO_FILES: ResolvedAttachments = { documents: [], imageNames: [] };

/** Hands out a number per refresh so an older, slower refresh cannot overwrite a newer one. */
export class ScopeRefreshGuard {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}

const threadScope = (scope: ChatScopeDecision) => ({
  scopeKind: scope.kind,
  projectId: scope.projectId,
  meetingId: scope.meetingId,
});

/**
 * One open conversation. Its turns are saved as a thread of the project that owns it (or of no
 * project), so history survives the session. The scope it started under decides whether a later
 * send continues it or starts a fresh thread; the old one stays in the history.
 */
export class ChatService {
  private conversation: Conversation | null = null;
  private decision: ChatScopeDecision = {
    isVisible: true,
    kind: 'AllMeetings',
    projectId: null,
    meetingId: null,
  };
  private sending = false;
  private pending: PendingTurn | null = null;
  private cancelSource: CancelSource | null = null;
  private localStreaming = false;
  private readonly refreshGuard = new ScopeRefreshGuard();
  private readonly listeners = new Set<() => void>();
  private readonly threadListeners = new Set<(owner: ThreadOwner) => void>();

  constructor(private readonly deps: ChatServiceDeps) {}

  get state(): ChatState {
    const messages = this.conversation?.messages ?? [];
    return {
      messages,
      isSending: this.sending,
      pending: this.pending,
      showScopeMismatch:
        this.conversation !== null &&
        this.decision.isVisible &&
        !matchesOpenThread(threadScope(this.conversation.scope), this.decision),
      hasMessages: messages.length > 0 || this.pending !== null,
      canStartNewChat: !this.sending,
      threadId: this.conversation?.thread?.saved === true ? this.conversation.thread.id : null,
      historySaved: this.conversation?.historySaved ?? true,
    };
  }

  get scope(): ChatScopeDecision {
    return this.decision;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Starts a scope refresh. Pass the token to `applyScope` with the result. */
  beginScopeRefresh(): number {
    return this.refreshGuard.begin();
  }

  /** Applies a refresh result unless a newer refresh began. Returns whether it was applied. */
  applyScope(token: number, decision: ChatScopeDecision): boolean {
    if (!this.refreshGuard.isCurrent(token)) return false;
    this.decision = decision;
    this.notify();
    return true;
  }

  /** Tells `listener` which owner's thread list changed (a thread was saved, renamed or deleted). */
  onThreadsChange(listener: (owner: ThreadOwner) => void): () => void {
    this.threadListeners.add(listener);
    return () => {
      this.threadListeners.delete(listener);
    };
  }

  /** Clears the open conversation, never a saved thread. Refused while sending. */
  newChat(): boolean {
    if (this.sending) return false;
    this.conversation = null;
    this.notify();
    return true;
  }

  /**
   * True while the local engine streams a chat answer. The rolling digest skips its update then,
   * so it never competes with the answer for the same model.
   */
  get localAnswerInFlight(): boolean {
    return this.localStreaming;
  }

  /** The stop button. Does nothing when no send is running. */
  cancel(): void {
    this.cancelSource?.cancel();
  }

  async send(
    draft: string,
    decision: ChatScopeDecision,
    /** Live scope: the transcript alone, or with the digest and session context. */
    liveTranscriptSnapshot: string | LiveContextSnapshot | null,
    options: SendOptions = {},
  ): Promise<ChatSendOutcome> {
    const userText = draft.trim();
    if (this.sending || !decision.isVisible || userText === '') return { status: 'ignored' };

    // The scope and the live snapshot are fixed here, not read again later.
    const scope = { ...decision };
    const live =
      liveTranscriptSnapshot !== null && typeof liveTranscriptSnapshot === 'object'
        ? { ...liveTranscriptSnapshot }
        : liveTranscriptSnapshot;
    const t = this.deps.translate;
    const userCreatedAt = this.deps.clock.now();
    const cancelSource = new CancelSource();
    this.cancelSource = cancelSource;
    this.sending = true;
    this.pending = { userText, assistantText: '' };
    this.notify();

    let staged: StagedImages | null = null;
    const wasStopped = (): boolean => cancelSource.cancelled;
    const cancelled = (): ChatSendOutcome => ({ status: 'cancelled', originalDraft: draft });
    const fail = (failure: ChatFailure): ChatSendOutcome => ({
      status: 'failed',
      failure,
      originalDraft: draft,
    });

    try {
      const open =
        this.conversation !== null && matchesOpenThread(threadScope(this.conversation.scope), scope)
          ? this.conversation
          : null;
      // A reopened thread whose meeting or Live take is gone is read-only, whatever the page does.
      if (open !== null && open.scopeStatus !== 'ok') return fail(scopeGoneFailure(t));
      const prior = open?.messages ?? [];

      // The engine decides the context size, so it is resolved before packing.
      const choice = choiceOf(options);
      const resolution =
        options.engine === undefined
          ? await this.deps.providers.resolve()
          : choice === undefined
            ? await this.deps.providers.resolve(options.engine)
            : await this.deps.providers.resolve(options.engine, choice);
      let provider: ChatStreamProvider;
      if (resolution.status === 'unavailable') return fail(providerRemovedFailure(t));
      if (resolution.status === 'needs-setup') {
        if (options.setupGate === undefined) {
          return { status: 'setup-required', kind: resolution.kind, originalDraft: draft };
        }
        const gated = await options.setupGate(resolution.kind);
        if (gated === null) return fail(setupCancelledFailure(t));
        provider = gated;
      } else {
        provider = resolution.provider;
      }
      if (wasStopped()) return cancelled();

      const lastUserTurn = prior.findLast((m) => m.role === 'user')?.text ?? '';
      const query = `${userText}\n${lastUserTurn}`;
      const packed = await this.pack(scope, live, provider.id, query);
      if (wasStopped()) return cancelled();
      if (packed.meetingGone) return fail(scopeGoneFailure(t));
      const context = packed.text;

      const ids = options.attachmentIds ?? [];
      const source = this.deps.attachments;
      const files = ids.length > 0 && source ? await source.resolve(ids) : NO_FILES;
      if (wasStopped()) return cancelled();
      // Only CLI engines see images. The local model is text only, and API engines do not get
      // them yet (v1), so both answer without them.
      const cli = isCliEngine(provider.id);
      const remote = isRemoteEngine(provider.id);
      let notice: string | null = null;
      if (files.imageNames.length > 0 && source) {
        if (cli) staged = await source.stageImages(ids);
        else notice = t(remote ? 'Ui_ChatAttachImagesApi' : 'Ui_ChatAttachImagesLocal');
      }
      if (wasStopped()) return cancelled();

      const prompt = buildPrompt(
        scope.kind,
        context,
        prior.map((m) => ({ role: m.role, text: m.text })),
        userText,
        {
          answerLanguage: answerLanguageName(this.deps.uiLanguage?.()),
          priorTurns: priorTurnLimitsFor(provider.id),
          attachments: packAttachments(
            files.documents,
            attachmentBudgetFor(provider.id, context.length),
            query,
          ),
          images:
            staged === null
              ? null
              : { names: staged.names, readFromDisk: readsImagesFromDisk(provider.id) },
        },
      );

      this.localStreaming = !remote;
      const answer = await this.stream(
        provider,
        prompt,
        cancelSource,
        staged === null
          ? undefined
          : { images: { directory: staged.directory, paths: staged.paths } },
      );
      // A stopped answer is dropped, even when the provider returned text before it noticed.
      if (wasStopped()) return cancelled();

      const text = answer.trim();
      if (text === '') return fail(emptyAnswerFailure(t));

      // The two messages get their own timestamps.
      const user: ChatMessage = {
        id: this.deps.newId(),
        role: 'user',
        text: userText,
        createdAt: userCreatedAt,
      };
      const assistant: ChatMessage = {
        id: this.deps.newId(),
        role: 'assistant',
        text,
        createdAt: this.deps.clock.now(),
      };
      this.conversation = await this.commitTurn(open, scope, packed.owner, [
        ...prior,
        user,
        assistant,
      ]);
      return {
        status: 'sent',
        user,
        assistant,
        notice,
        ...(packed.coverage === null ? {} : { coverage: packed.coverage }),
      };
    } catch (error) {
      if (wasStopped() || isCancellation(error)) return cancelled();
      return fail(sendFailedFailure(error, t));
    } finally {
      // The image copies live for one send only.
      this.localStreaming = false;
      await staged?.release();
      this.sending = false;
      this.pending = null;
      this.cancelSource = null;
      this.notify();
    }
  }

  /**
   * The context text for the scope, and the project that owns the conversation: the project of
   * the Project scope, of the meeting, or of the Live take (null for none).
   */
  private async pack(
    scope: ChatScopeDecision,
    live: string | LiveContextSnapshot | null,
    providerId: ProviderId | undefined,
    query: string,
  ): Promise<PackedContext> {
    const reader = this.deps.meetings;
    let meetings: readonly ContextMeeting[] = [];
    let owner: ThreadOwner = null;
    let meetingGone = false;
    if (scope.kind === 'Meeting' && scope.meetingId !== null) {
      const found = await reader.meetingById(scope.meetingId);
      meetings = found === null ? [] : [found];
      meetingGone = found === null;
      owner = found?.projectId ?? null;
    } else if (scope.kind === 'Project' && scope.projectId !== null) {
      meetings = await reader.meetingsInProject(scope.projectId, query);
      owner = scope.projectId;
    } else if (scope.kind === 'AllMeetings') {
      meetings = await reader.listRecent(query);
    }
    const snapshot: LiveContextSnapshot | null =
      scope.kind !== 'Live'
        ? null
        : live !== null && typeof live === 'object'
          ? live
          : { transcript: live };
    if (snapshot !== null) owner = snapshot.projectId ?? null;

    // The project block is the same kernel as the Live copilot and the summaries use.
    const block = await this.projectBlock(owner, providerId, query);
    const base = contextBudgetFor(providerId);
    // The local window is fixed: the block is taken out of the meeting text, not added to it.
    const budget =
      block === null || isRemoteEngine(providerId) ? base : carveProjectBlock(base, block.length);
    const projects =
      scope.kind === 'Project' || scope.kind === 'AllMeetings' ? await reader.listProjects() : [];
    const { text, coverage } = packContextWithCoverage(
      scope.kind,
      scope.projectId,
      scope.meetingId,
      snapshot === null ? live : { ...snapshot, project: block ?? snapshot.project ?? null },
      meetings,
      projects,
      this.deps.translate,
      { budget, query, projectBlock: block },
    );
    return { text, owner, meetingGone, coverage };
  }

  /** The packed project block, or null for no project, an unknown one, or a read that failed. */
  private async projectBlock(
    projectId: string | null,
    providerId: ProviderId | undefined,
    query: string,
  ): Promise<string | null> {
    const source = this.deps.projects;
    if (source === undefined || projectId === null) return null;
    try {
      const data = await source.get(projectId);
      if (data === null) return null;
      return packProjectContext({
        name: data.name,
        instructions: data.instructions,
        documents: data.documents,
        budget: projectBudgetFor('chat', providerId),
        query,
      });
    } catch (error) {
      // The answer does not wait on the project: it runs without its block.
      this.deps.logger?.warn('chat project context unavailable', { error });
      return null;
    }
  }

  /**
   * The conversation after a successful turn. The thread is created here, on the first answer,
   * and saved whole after every answer. A failed save is logged and the chat goes on in memory.
   */
  private async commitTurn(
    open: Conversation | null,
    scope: ChatScopeDecision,
    owner: ThreadOwner,
    messages: readonly ChatMessage[],
  ): Promise<Conversation> {
    const repo = this.deps.threads;
    const first = messages[0];
    let thread = open?.thread ?? null;
    if (repo === undefined || first === undefined) {
      return { scope, messages, thread, scopeStatus: 'ok', historySaved: true };
    }
    thread ??= {
      id: this.deps.newId(),
      owner,
      title: threadTitleOf(first.text),
      createdAt: isoOf(first.createdAt),
      saved: false,
    };
    const stored: ChatThread = {
      schemaVersion: 1,
      id: thread.id,
      ownerProjectId: thread.owner,
      scope: { kind: scope.kind, meetingId: scope.meetingId },
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: isoOf(this.deps.clock.now()),
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        createdAt: isoOf(m.createdAt),
      })),
    };
    const saved = await this.save(repo, stored);
    if (saved) this.notifyThreads(thread.owner);
    return {
      scope,
      messages,
      thread: { ...thread, saved: saved || thread.saved },
      scopeStatus: 'ok',
      historySaved: saved,
    };
  }

  private async save(repo: ChatThreadRepository, thread: ChatThread): Promise<boolean> {
    let result: Result<void>;
    try {
      result = await repo.save(thread);
    } catch (error) {
      this.deps.logger?.warn('chat history not saved', { error });
      return false;
    }
    if (!result.ok) this.deps.logger?.warn('chat history not saved', { reason: result.reason });
    return result.ok;
  }

  /** The saved conversations of an owner, newest first. A failed read is an empty list. */
  async listThreads(owner: ThreadOwner): Promise<readonly ChatThreadSummary[]> {
    try {
      return (await this.deps.threads?.list(owner)) ?? [];
    } catch (error) {
      this.deps.logger?.warn('chat history unreadable', { error });
      return [];
    }
  }

  /**
   * Makes a saved thread the open conversation. Refused while an answer is running. A thread
   * whose meeting was deleted, or that came from a Live take, opens read-only (`scopeStatus`).
   */
  async openThread(owner: ThreadOwner, id: string): Promise<OpenThreadOutcome> {
    const repo = this.deps.threads;
    if (this.sending) return { ok: false, reason: 'busy' };
    if (repo === undefined) return { ok: false, reason: 'not-found' };
    let stored: ChatThread | null;
    try {
      stored = await repo.get(owner, id);
    } catch (error) {
      this.deps.logger?.warn('chat thread unreadable', { error });
      return { ok: false, reason: 'corrupt' };
    }
    if (stored === null) return { ok: false, reason: 'not-found' };
    const scope: ThreadScope = {
      kind: stored.scope.kind,
      projectId: stored.ownerProjectId,
      meetingId: stored.scope.meetingId,
    };
    const scopeStatus = await this.scopeStatusOf(scope);
    // An answer may have started while the thread was being read.
    if (this.isSending()) return { ok: false, reason: 'busy' };
    const messages = stored.messages.map((m): ChatMessage => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: new Date(m.createdAt),
    }));
    this.conversation = {
      scope: { isVisible: true, ...scope },
      messages,
      thread: {
        id: stored.id,
        owner: stored.ownerProjectId,
        title: stored.title,
        createdAt: stored.createdAt,
        saved: true,
      },
      scopeStatus,
      historySaved: true,
    };
    this.notify();
    return {
      ok: true,
      thread: { id: stored.id, title: stored.title, scope, messages, scopeStatus },
    };
  }

  /** A Live take cannot be resumed, and a Meeting thread needs its meeting. */
  private async scopeStatusOf(scope: ThreadScope): Promise<ThreadScopeStatus> {
    if (scope.kind === 'Live') return 'live-ended';
    if (scope.kind !== 'Meeting') return 'ok';
    if (scope.meetingId === null) return 'meeting-missing';
    try {
      return (await this.deps.meetings.meetingById(scope.meetingId)) === null
        ? 'meeting-missing'
        : 'ok';
    } catch (error) {
      this.deps.logger?.warn('chat thread meeting unreadable', { error });
      return 'ok';
    }
  }

  /** Renames a saved thread. The open thread keeps the new title on its next save. */
  async renameThread(owner: ThreadOwner, id: string, title: string): Promise<boolean> {
    const repo = this.deps.threads;
    const clean = cutPrefix(singleLine(title).replace(/\s+/g, ' ').trim(), THREAD_TITLE_RENAME_MAX);
    if (repo === undefined || clean === '' || this.isOpenWhileSending(id)) return false;
    let renamed: boolean;
    try {
      renamed = await repo.rename(owner, id, clean);
    } catch (error) {
      this.deps.logger?.warn('chat thread not renamed', { error });
      return false;
    }
    if (!renamed) return false;
    const current = this.conversation;
    if (current?.thread?.id === id) {
      this.conversation = { ...current, thread: { ...current.thread, title: clean } };
    }
    this.notifyThreads(owner);
    return true;
  }

  /** Deletes a saved thread. Deleting the open one resets the chat; nothing else is touched. */
  async deleteThread(owner: ThreadOwner, id: string): Promise<boolean> {
    const repo = this.deps.threads;
    if (repo === undefined || this.isOpenWhileSending(id)) return false;
    let deleted: boolean;
    try {
      deleted = await repo.delete(owner, id);
    } catch (error) {
      this.deps.logger?.warn('chat thread not deleted', { error });
      return false;
    }
    if (!deleted) return false;
    if (this.conversation?.thread?.id === id && !this.sending) {
      this.conversation = null;
      this.notify();
    }
    this.notifyThreads(owner);
    return true;
  }

  /** The answer being written would save its thread again, so that thread is not touched now. */
  private isOpenWhileSending(id: string): boolean {
    return this.sending && this.conversation?.thread?.id === id;
  }

  /** Read through a method, so a check after an await is not folded into the one before it. */
  private isSending(): boolean {
    return this.sending;
  }

  private notifyThreads(owner: ThreadOwner): void {
    for (const listener of [...this.threadListeners]) listener(owner);
  }

  private async stream(
    provider: ChatStreamProvider,
    prompt: string,
    cancelSource: CancelSource,
    options?: ChatPromptOptions,
  ): Promise<string> {
    const coalescer = new StreamCoalescer(this.deps.clock, (text) => {
      if (cancelSource.cancelled || this.pending === null) return;
      this.pending = { userText: this.pending.userText, assistantText: text };
      this.notify();
    });
    const clock = this.deps.clock;
    const started = clock.now().getTime();
    let firstChunkMs: number | null = null;
    let chunks = 0;
    try {
      // A send without images passes no options at all.
      const pieces =
        options === undefined
          ? provider.streamPrompt(prompt, cancelSource.signal)
          : provider.streamPrompt(prompt, cancelSource.signal, options);
      for await (const chunk of pieces) {
        if (cancelSource.cancelled) break;
        firstChunkMs ??= clock.now().getTime() - started;
        chunks += 1;
        coalescer.append(chunk);
      }
      if (!cancelSource.cancelled) coalescer.flush();
      return coalescer.text;
    } finally {
      this.deps.logger?.info('chat answer streamed', {
        firstChunkMs,
        totalMs: clock.now().getTime() - started,
        chunks,
        chars: coalescer.text.length,
      });
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
