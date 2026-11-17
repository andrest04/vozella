import { MIN_SEARCH_CHARS } from '@vozella/core';
import { useEffect, useRef, useState } from 'react';
import { useMeetingListStore } from './meeting-list-store';
import type { MeetingScope } from './scope';
import type { SearchHits } from './search-results';

/** Reading inside every meeting waits for the typing to stop. */
export const SEARCH_DEBOUNCE_MS = 200;

const NO_HITS: SearchHits = new Map();

export interface MeetingSearch {
  readonly hits: SearchHits;
  /** The answer for this query has not arrived. */
  readonly searching: boolean;
  /** The last answer failed, so only titles were searched. */
  readonly failed: boolean;
}

interface Answer {
  readonly key: string;
  readonly hits: SearchHits;
  readonly failed: boolean;
}

/**
 * The second stage of a search. Titles filter at once in memory; this adds what is inside the
 * meetings. Only the newest request counts, and a change in the library asks again.
 */
export function useMeetingSearch(query: string, scope: MeetingScope): MeetingSearch {
  const listed = useMeetingListStore((state) => state.meetings);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const sequence = useRef(0);
  const text = query.trim();
  const applies = text.length >= MIN_SEARCH_CHARS;
  const key = JSON.stringify([text, scope]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    sequence.current += 1;
    if (!applies) return;
    const requestId = sequence.current;
    const timer = setTimeout(() => {
      void window.vozella
        .invoke('library.search', { query: text, scope: scopeRef.current, requestId })
        .then((result) => {
          if (requestId !== sequence.current || result.stale) return;
          setAnswer({
            key,
            hits: new Map(result.hits.map((hit) => [hit.meetingId, hit])),
            failed: false,
          });
        })
        .catch(() => {
          if (requestId === sequence.current) setAnswer({ key, hits: NO_HITS, failed: true });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [applies, key, text, listed]);

  if (!applies) return { hits: NO_HITS, searching: false, failed: false };
  // An answer for other text says nothing about this one, so until it comes only titles count.
  if (answer?.key !== key) return { hits: NO_HITS, searching: true, failed: false };
  return { hits: answer.hits, searching: false, failed: answer.failed };
}
