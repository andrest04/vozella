import type { PillEdgeDto } from '@vozella/contracts';
import { EXPANDED_RADIUS_DIP, PULSE_SCALE, TIMINGS } from '@vozella/core';
import { Keyboard, KeyboardOff, MessageSquare, Pause, Play, Square, Star } from 'lucide-react';
import { useEffect, useRef, type CSSProperties } from 'react';
import { AudioBars, Icon, Mark, cn } from '../../ui';
import { useReducedMotion } from '../../ui/use-reduced-motion';

export type HintSide = 'left' | 'right' | 'top' | 'bottom';

/** The started hint opens away from the docked edge. */
export function hintSide(edge: PillEdgeDto): HintSide {
  switch (edge) {
    case 'Right':
      return 'left';
    case 'Left':
      return 'right';
    case 'Top':
      return 'bottom';
    case 'Bottom':
      return 'top';
  }
}

export interface CapsuleHint {
  /** Changes on every hint, so a repeated hint plays its pulse again. */
  readonly id: number;
  readonly message: string;
  readonly side: HintSide;
  readonly pulse: boolean;
}

/** The type at cursor mark on the logo tile. Its label is the tooltip; the live region speaks. */
export interface CapsuleTyping {
  /** `paused` also covers a missing microphone: nothing reaches the field. */
  readonly mode: 'armed' | 'paused';
  readonly label: string;
}

export interface CapsuleLabels {
  readonly openApp: string;
  readonly pause: string;
  readonly resume: string;
  readonly stop: string;
  /** The highlight button's name and resting tooltip. */
  readonly highlight: string;
  readonly expand: string;
  readonly collapse: string;
  /** The tooltip of the collapse button; the accessible name stays `collapse`. */
  readonly collapseTooltip: string;
  readonly statusRecording: string;
  readonly statusPaused: string;
}

export interface CapsuleViewProps {
  readonly edge: PillEdgeDto;
  readonly vertical: boolean;
  readonly expanded: boolean;
  /** The capsule rectangle in DIP inside the window. */
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Opacity of the capsule while a snap flips the orientation. */
  readonly contentOpacity: number;
  readonly paused: boolean;
  /** 0..100. */
  readonly level: number;
  /** The bars animate only while the pill is on screen. */
  readonly running: boolean;
  /** `mm:ss`, minutes unbounded. */
  readonly elapsed: string;
  readonly hint: CapsuleHint | null;
  /** A take is recording or paused, so this moment can be marked. */
  readonly canHighlight: boolean;
  /** "Highlighted 00:12.34" while the feedback of the last mark lasts, null otherwise. */
  readonly highlighted: string | null;
  readonly labels: CapsuleLabels;
  /** Type at cursor is armed or paused; null or absent while it is off. */
  readonly typing?: CapsuleTyping | null;
  /** A short type at cursor note, drawn like the hint while no hint is showing. */
  readonly note?: string | null;
  /** The last type at cursor change, read politely by screen readers. */
  readonly typingAnnouncement?: string;
  readonly onOpenApp: () => void;
  readonly onTogglePause: () => void;
  readonly onStop: () => void;
  readonly onHighlight: () => void;
  readonly onToggleExpanded: () => void;
}

/** The surface of the started hint and of the type at cursor note: one voice for both. */
const NOTE =
  'pointer-events-none absolute z-10 rounded-control bg-ink px-1.5 py-1 text-center text-caption text-on-ink ' +
  'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 ' +
  'forced-colors:border forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]';

const BUTTON =
  'pill-no-drag inline-flex shrink-0 items-center justify-center rounded-full outline-offset-2 ' +
  'transition-colors duration-150 ease-out-quick motion-reduce:transition-none';

/**
 * The pill capsule: logo tile, level bars, elapsed time, highlight, pause, stop, chat toggle.
 * Seven items fit the 240 DIP vertical capsule only on a 4 DIP gap (208 DIP of items, six gaps).
 * Presentational: the container owns events and calls. The whole capsule drags the window; every
 * clickable element opts out with `pill-no-drag`. Always drawn on the dark tokens.
 */
export function CapsuleView(props: CapsuleViewProps) {
  const { rect, paused, labels, hint } = props;
  const typing = props.typing ?? null;
  const note = props.note ?? null;
  const radius = props.expanded ? EXPANDED_RADIUS_DIP : Math.min(rect.width, rect.height) / 2;
  const reduced = useReducedMotion();
  const pulse = hint?.pulse === true && !reduced;
  const content = useRef<HTMLDivElement>(null);

  // The pulse: scale 1 to 1.08 and back, two 180 ms sine legs, on the content only.
  useEffect(() => {
    const node = content.current;
    if (!pulse || !node || typeof (node as Partial<HTMLElement>).animate !== 'function') return;
    const run = node.animate(
      [{ transform: 'scale(1)' }, { transform: `scale(${String(PULSE_SCALE)})` }],
      {
        duration: TIMINGS.pulseMs,
        iterations: 2,
        direction: 'alternate',
        easing: 'cubic-bezier(0.37, 0, 0.63, 1)',
      },
    );
    return () => {
      run.cancel();
    };
  }, [pulse, hint?.id]);

  const style: CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    borderRadius: radius,
    opacity: props.contentOpacity,
    // Only the soft shadow lives in the 8 DIP gutter around the capsule.
    boxShadow: 'var(--pill-shadow)',
  };

  return (
    <div
      id="LiveCopilotCapsule"
      data-testid="LiveCopilotCapsule"
      data-orientation={props.vertical ? 'vertical' : 'horizontal'}
      data-edge={props.edge}
      data-expanded={props.expanded}
      {...(pulse ? { 'data-pulse': String(hint.id) } : {})}
      style={style}
      className="pill-drag absolute box-border overflow-hidden border border-hairline bg-paper-raised text-ink select-none forced-colors:border-[CanvasText]"
    >
      <div
        ref={content}
        className={cn(
          'flex h-full w-full items-center justify-center gap-1',
          props.vertical ? 'flex-col' : 'flex-row',
        )}
      >
        <button
          id="BtnLiveCopilotLogoOpenApp"
          type="button"
          data-item="logo"
          aria-label={labels.openApp}
          title={labels.openApp}
          onClick={props.onOpenApp}
          className={cn(
            BUTTON,
            'relative size-8 rounded-overlay border border-hairline bg-paper hover:bg-hover active:bg-pressed forced-colors:border-[ButtonBorder]',
          )}
        >
          <Mark size={20} />
          {typing ? (
            // Glyph and fill both change with the mode, so color never carries it alone.
            <span
              data-testid="pill-cursor-typing-badge"
              data-mode={typing.mode}
              title={typing.label}
              aria-hidden="true"
              className={cn(
                'absolute -right-1.5 -bottom-1.5 flex size-4.5 items-center justify-center rounded-full border',
                typing.mode === 'armed'
                  ? 'border-ink bg-ink text-on-ink'
                  : 'border-border-control bg-paper-raised text-ink',
                'forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]',
              )}
            >
              <Icon icon={typing.mode === 'armed' ? Keyboard : KeyboardOff} size={12} />
            </span>
          ) : null}
        </button>
        <div data-item="bars" className="flex items-center justify-center">
          <AudioBars level={props.level} paused={paused} running={props.running} />
        </div>
        <span
          id="TxtLiveCopilotElapsed"
          data-testid="TxtLiveCopilotElapsed"
          data-item="elapsed"
          title={paused ? labels.statusPaused : labels.statusRecording}
          className="min-w-10 text-center font-mono text-caption text-ink-muted tabular-nums"
        >
          {props.elapsed}
        </span>
        <button
          id="BtnLiveCopilotHighlight"
          type="button"
          data-item="highlight"
          {...(props.highlighted !== null ? { 'data-marked': 'true' } : {})}
          aria-label={labels.highlight}
          title={props.highlighted ?? labels.highlight}
          disabled={!props.canHighlight}
          onClick={props.onHighlight}
          className={cn(
            BUTTON,
            'size-8 text-ink hover:not-disabled:bg-hover active:not-disabled:bg-pressed',
            'disabled:cursor-not-allowed disabled:opacity-50 forced-colors:disabled:text-[GrayText]',
            props.highlighted !== null && 'bg-pressed',
          )}
        >
          <Icon
            icon={Star}
            size={16}
            className={props.highlighted !== null ? 'fill-current' : undefined}
          />
        </button>
        <button
          id="BtnLiveCopilotPause"
          type="button"
          data-item="pause"
          data-glyph={paused ? 'play' : 'pause'}
          aria-label={paused ? labels.resume : labels.pause}
          title={paused ? labels.resume : labels.pause}
          onClick={props.onTogglePause}
          className={cn(
            BUTTON,
            'size-9 border border-border-control text-ink hover:bg-hover active:bg-pressed forced-colors:border-[ButtonBorder]',
          )}
        >
          <Icon icon={paused ? Play : Pause} size={16} />
        </button>
        <button
          id="BtnLiveCopilotStop"
          type="button"
          data-item="stop"
          aria-label={labels.stop}
          title={labels.stop}
          onClick={props.onStop}
          className={cn(
            BUTTON,
            'size-9 bg-signal text-on-signal hover:opacity-85 active:opacity-70',
            'forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]',
          )}
        >
          <Icon icon={Square} size={14} />
        </button>
        <button
          id="BtnLiveCopilotChat"
          type="button"
          data-item="chat"
          aria-label={props.expanded ? labels.collapse : labels.expand}
          title={props.expanded ? labels.collapseTooltip : labels.expand}
          aria-expanded={props.expanded}
          onClick={props.onToggleExpanded}
          className={cn(
            BUTTON,
            'size-8 text-ink hover:bg-hover active:bg-pressed',
            props.expanded && 'bg-hover forced-colors:border forced-colors:border-[CanvasText]',
          )}
        >
          <Icon icon={MessageSquare} size={16} />
        </button>
      </div>
      {/* Always mounted, so the mark is announced the moment its text arrives. A bare polite
          live region, not role="status": that role names the started hint on this page. */}
      <span
        aria-live="polite"
        aria-atomic="true"
        data-testid="pill-highlight-status"
        className="sr-only"
      >
        {props.highlighted ?? ''}
      </span>
      <span
        aria-live="polite"
        aria-atomic="true"
        data-testid="pill-cursor-typing-status"
        className="sr-only"
      >
        {props.typingAnnouncement ?? ''}
      </span>
      {hint ? (
        <div
          role="status"
          data-testid="pill-hint"
          data-side={hint.side}
          className={cn(
            NOTE,
            props.vertical ? 'w-[calc(100%-4px)]' : 'max-w-[85%] whitespace-nowrap',
          )}
        >
          {hint.message}
        </div>
      ) : note !== null ? (
        // No role: the live region above already says it, and only the hint is a status.
        <div
          data-testid="pill-cursor-typing-note"
          className={cn(
            NOTE,
            'animate-fade-in motion-reduce:animate-none',
            // A note can run longer than the hint: it wraps instead of running off the capsule.
            props.vertical ? 'w-[calc(100%-4px)]' : 'w-max max-w-[85%]',
          )}
        >
          {note}
        </div>
      ) : null}
    </div>
  );
}
