import type { Projection } from "./types.js";

/**
 * The exact native turn item T3 reads one message by, as the projection publishes it: the user or assistant message item of that
 * thread whose messageId matches. A message ID is provenance and never an itemId; nothing here constructs an item ID.
 */
export const messageReadItemId = (projection: Projection | null | undefined, threadId: string, messageId: string): string | null => {
  const item = projection?.turnItems?.find(value => value.messageId === messageId && value.threadId === threadId &&
    (value.type === "user_message" || value.type === "assistant_message"));
  return typeof item?.id === "string" ? item.id : null;
};

/** The one rule every message pointer is read by: its exact read handle, or paging the thread when the message has none yet. */
export const messageReadRule = "Read a named message with t3_thread_read itemId set to its exact readItemId; a messageId is provenance, never an itemId. " +
  "Without a readItemId, page that thread's view messages with a small limit and afterPosition=nextPosition and match the messageId. " +
  "Use runLimit: 1 unless more run history is needed.";
