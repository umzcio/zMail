// @vitest-environment jsdom
// When an opened email counts as read: at once, after a delay, on moving to another, or never; marking by hand wins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email, Folder } from "@/lib/types";

const gmail = { id: "g", kind: "gmail" as const, name: "Gmail", address: "z@gmail.com" };
const folders: Folder[] = [{ id: "g:INBOX", accountId: "g", name: "Inbox", system: "inbox" }];
const row = (id: string) =>
  ({ id, accountId: "g", threadId: id, folderId: "g:INBOX", from: { name: "A", address: "a@x.com" }, to: [], subject: id, snippet: "", text: "", date: "2026-01-01T00:00:00Z", unread: true, starred: false, labels: ["INBOX"] }) as Email;

vi.mock("@/lib/accounts", () => ({
  loadRegistry: async () => [gmail],
  saveRegistry: async () => {},
  calendarProviderFor: () => ({ accountId: "g", nativeVideo: [], listCalendars: async () => [], listEvents: async () => [] }),
  mailProviderFor: () => ({ account: gmail, batchSize: 50, listFolders: async () => folders, listMessages: async () => [], getMessage: async (id: string) => row(id) }),
}));
vi.mock("@/lib/db", () => ({ kvGet: async () => null, kvSet: async () => {}, cacheListFolders: async () => [], cacheListMessages: async () => [], cachePutMessages: async () => {} }));
vi.mock("@/lib/oauth", () => ({ signOut: async () => {} }));
vi.mock("@/lib/ai/triage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ai/triage")>()), triageAll: async () => ({ done: 0, failed: 0 }) }));
vi.mock("sonner", () => {
  const t = () => 1;
  t.error = t;
  t.success = t;
  return { toast: t };
});

const { useMail } = await import("@/lib/store");
const { useSettings } = await import("@/lib/settings");
const realSetRead = useMail.getState().setRead;
const setRead = vi.fn(async (ids: string[], read: boolean) => {
  void ids;
  void read;
  return { error: undefined, undo: [] } as never;
});
const marked = () => setRead.mock.calls.filter(([, read]) => read).map(([ids]) => ids[0]);
const open = (id: string | null) => useMail.getState().select(id);

beforeEach(async () => {
  if (!useMail.getState().accounts.length) await useMail.getState().load();
  useMail.setState({ folders, view: { kind: "inbox" }, emails: [row("a"), row("b")], selectedId: null, compose: null, setRead });
  setRead.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  open(null);
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  useSettings.setState({ markRead: "open", markReadDelay: 5 });
});

describe("marking an opened email read", () => {
  it("marks it at once by default", () => {
    open("a");
    expect(marked()).toEqual(["a"]);
  });

  it("waits the delay, and only for the email still open", () => {
    useSettings.setState({ markRead: "delay", markReadDelay: 3 });
    open("a");
    vi.advanceTimersByTime(2000);
    open("b");
    vi.advanceTimersByTime(2999);
    expect(marked()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(marked()).toEqual(["b"]);
  });

  it("marks it when you move to another email, or close it", () => {
    useSettings.setState({ markRead: "leave" });
    open("a");
    expect(marked()).toEqual([]);
    open("b");
    expect(marked()).toEqual(["a"]);
    open(null);
    expect(marked()).toEqual(["a", "b"]);
  });

  it("never marks it with Never", () => {
    useSettings.setState({ markRead: "never" });
    open("a");
    open("b");
    vi.advanceTimersByTime(60_000);
    expect(marked()).toEqual([]);
  });

  it("lets marking by hand win over a pending read", () => {
    useSettings.setState({ markRead: "leave" });
    open("a");
    void realSetRead(["a"], false);
    open("b");
    expect(marked()).toEqual([]);
  });

  it("falls back to a sane delay when the saved one is out of range", () => {
    useSettings.setState({ markRead: "delay", markReadDelay: -4 });
    open("a");
    vi.advanceTimersByTime(1000);
    expect(marked()).toEqual(["a"]);
  });
});
