// When an opened email counts as read (Settings → Appearance → Reading): at once, after it has been
// open a few seconds, when you move to another email, or only when you mark it, as Outlook offers.
// One email at a time is waiting to count; marking it read or unread by hand ends the wait.

import { useSettings, type MarkRead } from "@/lib/settings";

const WHEN: readonly MarkRead[] = ["open", "delay", "leave", "never"];
export const MARK_READ_DELAY = { min: 1, max: 60 } as const;

export function readPolicy(): { when: MarkRead; ms: number } {
  const s = useSettings.getState();
  const when = WHEN.includes(s.markRead) ? s.markRead : "open";
  const secs = Number.isFinite(s.markReadDelay) ? Math.round(s.markReadDelay) : 5;
  return { when, ms: Math.min(MARK_READ_DELAY.max, Math.max(MARK_READ_DELAY.min, secs)) * 1000 };
}

let waiting: { id: string; timer?: ReturnType<typeof setTimeout> } | null = null;

function stop() {
  clearTimeout(waiting?.timer);
  waiting = null;
}

/**
 * An unread email just opened in the reader. `stillOpen` is checked again when the delay ends, so an
 * email you've already left never counts as read on a timer.
 */
export function openedUnread(id: string, mark: (id: string) => void, stillOpen: (id: string) => boolean) {
  stop();
  const { when, ms } = readPolicy();
  if (when === "open") return mark(id);
  if (when === "never") return;
  waiting = { id };
  if (when === "delay")
    waiting.timer = setTimeout(() => {
      if (waiting?.id !== id) return;
      stop();
      if (stillOpen(id)) mark(id);
    }, ms);
}

/** The reader moved off `id`, to another email or closed. With "when I move on", that is when it counts. */
export function leftEmail(id: string, mark: (id: string) => void) {
  if (waiting?.id !== id) return;
  stop();
  if (readPolicy().when === "leave") mark(id);
}

/** Marked read or unread by hand: that choice stands. */
export function settledByHand(ids: readonly string[]) {
  if (waiting && ids.includes(waiting.id)) stop();
}
