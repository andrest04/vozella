import { create } from 'zustand';

/**
 * What another page asks of the chat panel. Features never import each other, so a page that
 * wants a chat opened leaves the request here and the panel carries it out: the panel opens, and
 * for a thread it reopens it and pins its scope.
 */
export type ChatRequest =
  | { readonly kind: 'open-thread'; readonly projectId: string | null; readonly threadId: string }
  | { readonly kind: 'new-chat'; readonly projectId: string | null };

interface ChatRequestState {
  readonly request: (ChatRequest & { readonly serial: number }) | null;
}

export const useChatRequests = create<ChatRequestState>(() => ({ request: null }));

let serial = 0;

/** Leaves a request for the panel. Asking twice for the same thread is two requests. */
export function requestChat(request: ChatRequest): void {
  serial += 1;
  useChatRequests.setState({ request: { ...request, serial } });
}

/** The panel calls this once it has taken the request, so nothing runs twice. */
export function takeChatRequest(): (ChatRequest & { readonly serial: number }) | null {
  const { request } = useChatRequests.getState();
  useChatRequests.setState({ request: null });
  return request;
}
