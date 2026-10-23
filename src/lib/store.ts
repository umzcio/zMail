// App state: mailboxes, triage results, selection and the actions that tie
// mail providers to the decision model.

import { create } from "zustand";
import { toast } from "sonner";
import { filingRuleFor, isLaneRule, laneFor, normalizeFrom, planRuleRun, ruleOp, type AutoRule, type RuleAction } from "@/lib/rules";
import type { Email, Folder, SenderHabit, Triage } from "@/lib/types";
import { CALENDARS, seedCalendar } from "@/lib/calendar/mock-calendar";
import type { MailProvider, SyncChanges } from "@/lib/mail/provider";
import { folderForLabels, labelChangesForMove } from "@/lib/google/gmail-map";
import { chunk, type BulkOp, type BulkResult, type UndoEntry } from "@/lib/mail/bulk";
import { applyMockOverlay } from "@/lib/mail/mock-provider";
import { calendarProviderFor, loadRegistry, mailProviderFor, saveRegistry } from "@/lib/accounts";
import { signOut } from "@/lib/oauth";
import { cleanBodyHtml, textToBodyHtml } from "@/lib/mail/compose-html";
import { restoreSignature, splitSavedSignature } from "@/lib/signature";
import { cacheDeleteAccount, cacheGetMessage, cacheListFolders, cacheListMessages, cachePutMessages, kvGet, kvSet } from "@/lib/db";
import { ME } from "@/lib/mail/mock-data";
import { deriveMe, macUserName } from "@/lib/me";
import { computeHabits, recordFiling } from "@/lib/ai/habits";
import { triageAll } from "@/lib/ai/triage";
import { pool } from "@/lib/google/gmail";
import { HttpError } from "@/lib/transport";
import { AUTO_REPLY_MODEL, autoReplyTriage, isAutoReply } from "@/lib/mail/auto-reply";
import { NeedsPermissionError, type AutoReply } from "@/lib/mail/auto-replies";
import { decisionProvider, generativeProvider } from "@/lib/ai/providers";
import { isDateCandidate } from "@/lib/date-candidates";
import { clipText } from "@/lib/mail/clip-text";
import { useSettings } from "@/lib/settings";
import { extractDates } from "@/lib/ai/dates";
import { sectionsKey, type MailSection } from "@/lib/sections";
import type { ScheduledSend } from "@/lib/mail/scheduled";
import type { ActionResult, BackfillState, Compose, ComposeOpened, MailState } from "./store/types";
import { capLessons, learn, lessonsFromOverrides, senderExamples, type Lesson } from "./store/learning";
import { calProviders, providerFor, providers } from "./store/providers";
import { countsFor, pendingCounts, scheduleCountRefresh } from "./store/counts";
import { leftEmail, openedUnread, settledByHand } from "./store/read-on-open";
import { batched, flagging, groupBy, hold, inLane, runBulk, type BulkJob } from "./store/batching";
import { calendarAccountsChanged, syncCalendars } from "./store/calendar-sync";
import { calendarActions } from "./store/calendar-actions";
import { folderActions } from "./store/folder-actions";
import { SNAPSHOT_KEY, restore, startAutosave, type Snapshot } from "./store/persistence";
import { SCHEDULED_KEY, releaseEditing, scheduledActions, setScheduled, startScheduler, withoutEditing } from "./store/scheduler";
import { draftBlockFingerprint, forgetDraftSignatures, isOwnDraftSignature, rememberDraftSignature } from "./store/draft-signatures";
import { applyEmailChanges, mergeByDateDesc, protectPending } from "./store/merge";
import { ageOutIds, categoryOf, inNeedsYou, inboxFolderIds, isInbox, nextAfterRemoval, orderedEmails, repliedIds, resultsMode, sectionOf } from "./store/selectors";
import { held } from "./store/held";
import { adoptInto, searchActions } from "./store/search";

export type {
  ActionResult,
  BackfillState,
  Compose,
  ComposeEdit,
  ComposeEditPatch,
  ComposeOpened,
  ComposeView,
  Resolution,
  SearchResults,
  SearchScope,
  SearchState,
  View,
} from "./store/types";
export { MIN_INDEX_QUERY } from "./store/search";
export { LESSONS_PER_SENDER, learn, lessonsFromOverrides, senderExamples, type Lesson } from "./store/learning";
export { calendarProvider, providerOf } from "./store/providers";
export { ensureEventRange, resetCalendarSync, syncCalendars } from "./store/calendar-sync";
export { snapshot } from "./store/persistence";
export {
  ageOutIds,
  allDayOn,
  allInboxesUnread,
  backfillLine,
  bucketOf,
  categoryOf,
  childFolders,
  childFoldersIndexed,
  datesShownFor,
  dayEvents,
  defaultCalendarFor,
  emailForEvent,
  eventForEmail,
  eventHue,
  eventIndex,
  eventMailIndex,
  eventsOn,
  folderHue,
  folderPath,
  folderPathCached,
  folderUnread,
  homeGroups,
  homeInbox,
  idsByFolder,
  inboxEmails,
  inboxFolderIds,
  inNeedsYou,
  inboxSuggestions,
  isInbox,
  listEmails,
  neighborsOf,
  nextAfterRemoval,
  nextEvent,
  orderedEmails,
  repliedIds,
  resultEmails,
  resultGroups,
  resultsMode,
  SEARCH_MAX,
  searchHere,
  searchKey,
  searchWords,
  inSearchScope,
  sameDay,
  sectionOf,
  selectHome,
  selectSuggestions,
  starredCount,
  suggestionFor,
  todayKeep,
  unreadByFolder,
  upcomingEvents,
  visibleEvents,
  visibleSections,
  type DayEvents,
  type EventIndex,
  type Sel,
  type SuggestionSel,
} from "./store/selectors";
export { applyEmailChanges, mergeByDateDesc, protectPending } from "./store/merge";
export { folderKey, splitFolderPath, userFolderAt } from "./store/folder-actions";

const NOTHING: ActionResult = { done: [], failed: [] };

function mergeResults(results: ActionResult[]): ActionResult {
  return {
    done: results.flatMap((r) => r.done),
    failed: results.flatMap((r) => r.failed),
    error: results.find((r) => r.error)?.error,
  };
}

let loaded = false;
let refreshing: Promise<void> | null = null;
let sorting: Promise<void> | null = null;
/** Senders whose other inbox mail re-sorts after a correction, and the corrected emails left out of it. */
let resort: { senders: Set<string>; corrected: Set<string>; timer?: ReturnType<typeof setTimeout> } = { senders: new Set(), corrected: new Set() };
const RESORT_DELAY_MS = 1200;
/** Newest emails per sender re-sorted after a correction. */
const RESORT_PER_SENDER = 25;
/** Body loads in flight, by email id (the reader and the composer may ask at once). */
const bodyLoads = new Map<string, Promise<Email | undefined>>();
/** Ids whose full body ensureBody loaded, most recent last; older ones are slimmed again past KEEP_BODIES. */
const KEEP_BODIES = 12;
const loadedBodies: string[] = [];
/** A full row back to the slim shape Rust's SLIM_JSON makes for list rows. */
export function slimRow(e: Email): Email {
  const { html: _, ...rest } = e;
  return { ...rest, text: clipText(e.text, 8000), bodyTrimmed: true };
}
/** Incoming synced/backfilled rows, slimmed except the open email, the reply source and bodies ensureBody still keeps. */
export function slimIncoming(rows: Email[], s: { selectedId: string | null; compose: { replyTo?: string } | null }): Email[] {
  return rows.map((e) =>
    e.bodyTrimmed || e.id === s.selectedId || e.id === s.compose?.replyTo || loadedBodies.includes(e.id) ? e : slimRow(e),
  );
}
/** Fetched cid: images by email id (small LRU; Map keeps insertion order), and loads in flight. */
const INLINE_CACHE = 20;
const inlineCache = new Map<string, Map<string, string>>();
const inlineLoads = new Map<string, Promise<Map<string, string>>>();
/** Bumped by each openCompose, so a compose waiting on a body load can't reopen a stale one. */
let composeSeq = 0;
/** An openCompose is waiting on the replied-to body: the composer is about to open. */
let composeLoading = false;
/** A 4xx that means the page token itself is bad (not auth or throttling). */
function staleCursorError(err: unknown) {
  return err instanceof HttpError && err.status >= 400 && err.status < 500 && ![401, 403, 429].includes(err.status);
}

/** The Inbox backfill loop running now (never two at once). */
let backfilling: Promise<void> | null = null;
/** Accounts the backfill has tried this session (once per account per session). */
const backfillTried = new Set<string>();
const BACKFILL_PAUSE_MS = 500;
/** Triage results are applied to the store at most this often. */
const TRIAGE_FLUSH_MS = 250;
/** Emails being read for dates right now, and recent failures (retried after 30 min). */
const finding = new Set<string>();
/** Automatic rules that already failed this session (toast once). */
const failedRules = new Set<string>();
/** Failed automatic-rule attempts per email id this session; after MAX_RULE_TRIES the mail is sorted normally and rules leave it alone. */
const ruleFails = new Map<string, number>();
const MAX_RULE_TRIES = 3;
const findFailed = new Map<string, number>();

const sysFolder = (folders: Folder[], accountId: string, kind: Folder["system"]) =>
  folders.find((f) => f.accountId === accountId && f.system === kind);

/** A composer is open, or opening (its email's body still loading): the single-key mail shortcuts stay off. */
export function composerActive() {
  return composeLoading || !!useMail.getState().compose;
}

/** Write changed emails of real accounts back to the local cache immediately. */
function recache(ids: string[]) {
  const want = new Set(ids);
  const { accounts, emails } = useMail.getState();
  const real = new Set(accounts.filter((a) => a.kind !== "mock").map((a) => a.id));
  const byAccount = new Map<string, Email[]>();
  for (const e of emails) {
    if (!want.has(e.id) || !real.has(e.accountId)) continue;
    const list = byAccount.get(e.accountId);
    if (list) list.push(e);
    else byAccount.set(e.accountId, [e]);
  }
  for (const [accountId, list] of byAccount)
    void cachePutMessages(accountId, list.map((e) => ({ id: e.id, folder_id: e.folderId, date: e.date, json: JSON.stringify(e) })));
}

/** Emails whose move is still on its way to the server; a second move of them is ignored. */
const moving = new Set<string>();

export const useMail = create<MailState>()((set, get) => {
  /** A pending "Save this draft?" that ends without Save or Discard: whoever asked hears its `then` won't run. */
  const endCloseAsk = () => {
    const ask = get().composeCloseAsk;
    if (!ask) return;
    set({ composeCloseAsk: null });
    ask.cancel?.();
  };
  /** Move each email to its own account's system folder of `kind`. */
  const toSystem = async (ids: string[], kind: Folder["system"]): Promise<ActionResult> => {
    const { emails, folders } = get();
    const byTarget = new Map<string, string[]>();
    const missing: string[] = [];
    for (const id of ids) {
      const e = emails.find((x) => x.id === id);
      if (!e) continue;
      const target = sysFolder(folders, e.accountId, kind);
      if (!target) missing.push(id);
      else byTarget.set(target.id, [...(byTarget.get(target.id) ?? []), id]);
    }
    // Every group starts (and leaves the screen) now; none waits for another's server reply.
    const results = await Promise.all([...byTarget].map(([target, group]) => get().move(group, target, { learn: false })));
    if (missing.length) results.push({ done: [], failed: missing, error: `This account has no ${kind} folder.` });
    return mergeResults(results);
  };

  /** Flip read or star at once; the server calls queue behind earlier ones. Refused changes flip back. */
  const setFlag = async (list: Email[], flag: "unread" | "starred", value: boolean): Promise<ActionResult> => {
    if (!list.length) return NOTHING;
    applyPatches(new Map(list.map((e) => [e.id, { [flag]: value }])));
    const ids = (part: Email[]) => part.map((e) => e.id);
    hold(flagging[flag], ids(list), 1);
    let failed: Set<string>, error: string | undefined;
    try {
      ({ failed, error } = await inLane(flag, () =>
        batched(list, (p, part) => (flag === "unread" ? p.batchSetRead(ids(part), !value) : p.batchSetStarred(ids(part), value))),
      ));
      // Only undo our own change: a later press may already have flipped it again.
      const back = new Map<string, Partial<Email>>();
      for (const e of get().emails) if (failed.has(e.id) && e[flag] === value) back.set(e.id, { [flag]: !value });
      applyPatches(back);
    } finally {
      hold(flagging[flag], ids(list), -1);
    }
    return { done: ids(list).filter((id) => !failed.has(id)), failed: [...failed], error: failed.size ? (error ?? "The server didn't accept the change.") : undefined };
  };

  /** Read mail for due dates and events (writing model, once per email). */
  const findDates = async (ids?: Iterable<string>) => {
    const s = get();
    const everywhere = useSettings.getState().findDatesEverywhere;
    const now = Date.now();
    let pool_: Email[] = s.emails;
    if (ids) {
      // Scoped scan: just these ids, plus earlier failures whose backoff has expired.
      const want = new Set(ids);
      for (const [id, at] of findFailed) if (now - at > 30 * 6e4) want.add(id);
      pool_ = [];
      const byId = new Map<string, Email>();
      for (const e of s.emails) if (want.has(e.id)) byId.set(e.id, e);
      for (const id of want) {
        const e = byId.get(id);
        if (e) pool_.push(e);
      }
    }
    const todo = pool_.filter(
      (e) =>
        !(e.id in s.dateFinds) &&
        !finding.has(e.id) &&
        Date.now() - (findFailed.get(e.id) ?? 0) > 30 * 6e4 &&
        isDateCandidate(e, {
          inbox: isInbox(s, e),
          category: categoryOf(s, e.id),
          section: sectionOf(s, e),
          noDateSenders: s.noDateSenders,
          everywhere,
          now,
        }),
    );
    if (!todo.length) return;
    const provider = generativeProvider();
    for (const e of todo) finding.add(e.id);
    await pool(todo, 2, async (e) => {
      try {
        const finds = await extractDates(provider, e, sectionOf(get(), e)?.name);
        set((st) => ({ dateFinds: { ...st.dateFinds, [e.id]: finds } }));
      } catch (err) {
        findFailed.set(e.id, Date.now());
        console.error("[dates]", e.id, err);
      } finally {
        finding.delete(e.id);
      }
    });
  };

  /** Run automatic rules on new inbox mail (no triage yet), before triage sorts it. */
  const applyAutoRules = async (): Promise<Set<string>> => {
    const skip = new Set<string>();
    const s = get();
    if (!s.autoRules.some((r) => r.enabled)) return skip;
    const inbox = (e: Email) => isInbox(get(), e);
    const fresh = s.emails.filter((e) => !s.triage[e.id] && !s.autoHandled[e.id] && (ruleFails.get(e.id) ?? 0) < MAX_RULE_TRIES && inbox(e));
    const plan = planRuleRun(s.autoRules, fresh, inbox);
    const handled: { rule: AutoRule; n: number; undo: UndoEntry[]; op: BulkOp }[] = [];
    for (const { rule, emails } of plan) {
      const action = rule.action;
      if (typeof action === "object" && "lane" in action) continue; // planRuleRun never returns these
      const op = ruleOp(action);
      let res: BulkResult | undefined;
      try {
        res = await get().bulkApply(emails, op);
      } catch (err) {
        console.error("[auto-rules]", rule.id, err);
      }
      const failedIds = new Set((res ? res.failed : emails).map((e) => e.id));
      const okIds = emails.filter((e) => !failedIds.has(e.id)).map((e) => e.id);
      if (okIds.length) set((st) => ({ autoHandled: { ...st.autoHandled, ...Object.fromEntries(okIds.map((id) => [id, true as const])) } }));
      for (const id of failedIds) {
        const n = (ruleFails.get(id) ?? 0) + 1;
        ruleFails.set(id, n);
        // Leave it untriaged so the next refresh retries; give up after a few tries.
        if (n < MAX_RULE_TRIES) skip.add(id);
      }
      if (!res || res.error || res.failed.length) {
        if (!failedRules.has(rule.id)) {
          failedRules.add(rule.id);
          toast("An automatic rule couldn't run");
        }
      }
      if (!res || !res.done) continue;
      const at = new Date().toISOString();
      set((st) => ({ autoRules: st.autoRules.map((r) => (r.id === rule.id ? { ...r, hits: r.hits + res!.done, lastHitAt: at } : r)) }));
      handled.push({ rule, n: res.done, undo: res.undo, op });
    }
    if (!handled.length) return skip;
    const total = handled.reduce((n, h) => n + h.n, 0);
    const one = handled.length === 1 ? handled[0].rule : null;
    const verb = (a: RuleAction) => (a === "trash" ? "trashed" : a === "archive" ? "archived" : a === "mark_read" ? "marked read" : "moved");
    toast(one ? `Auto-${verb(one.action)} ${total} from ${one.match.from}` : `Automatic rules handled ${total} emails`, {
      action: {
        label: "Undo",
        onClick: () => {
          for (const h of handled)
            void get()
              .bulkUndo(h.undo, h.op)
              .catch(() => toast("Couldn't undo"));
        },
      },
    });
    return skip;
  };

  /**
   * Pin inbox mail to the lane of any matching lane rule, over the model's answer. A lane set by the user for
   * one email wins; lanes a rule set are lifted when no rule matches any more. Returns how many emails changed.
   */
  const applyLaneRules = (): number => {
    const s = get();
    if (!s.autoRules.some((r) => r.enabled && isLaneRule(r)) && !Object.keys(s.laneRuled).length) return 0;
    const inbox = (e: Email) => isInbox(s, e);
    const overrides = { ...s.overrides };
    const laneRuled = { ...s.laneRuled };
    let changed = 0;
    for (const e of s.emails) {
      const ruled = laneRuled[e.id] !== undefined;
      const lane = laneFor(s.autoRules, e, inbox);
      if (lane) {
        if ((overrides[e.id] === undefined || ruled) && overrides[e.id] !== lane) {
          overrides[e.id] = lane;
          laneRuled[e.id] = lane;
          changed++;
        }
      } else if (ruled) {
        delete overrides[e.id];
        delete laneRuled[e.id];
        changed++;
      }
    }
    if (changed) set({ overrides, laneRuled });
    return changed;
  };

  /** Needs-you mail past its due date or two weeks old, and mail you've replied to elsewhere, leaves Needs you. */
  const settleNeedsYou = () => {
    get().resolve(ageOutIds(get(), Date.now()), "aged");
    get().resolve(repliedIds(get()), "replied");
  };

  /** You replied to `email` from zMail: it and the earlier Needs-you mail in its thread leave Needs you. */
  const resolveReplied = (email: Email | undefined) => {
    if (!email) return;
    const s = get();
    const now = Date.now();
    const earlier = s.emails.filter(
      (e) => e.accountId === email.accountId && e.threadId === email.threadId && Date.parse(e.date) <= now && isInbox(s, e) && inNeedsYou(s, e),
    );
    get().resolve([...new Set([email.id, ...earlier.map((e) => e.id)])], "replied");
  };

  /** Pull changes from real accounts and merge them per account. */
  const doRefresh = async () => {
    const real = [...providers.values()].filter((p) => p.account.kind !== "mock");
    const withPending = (folders: Folder[]) => folders.map((f) => (pendingCounts.has(f.id) ? { ...f, unread: pendingCounts.get(f.id) } : f));
    /** Read one account's cached folders and Inbox mail, as load() does. */
    const readCache = async (accountId: string, known: Folder[]) => {
      const folders = known.length ? known : (await cacheListFolders(accountId).catch(() => [] as string[])).map((j) => JSON.parse(j) as Folder);
      const inbox = folders.find((f) => f.system === "inbox");
      const emails = (await cacheListMessages(accountId, undefined, inbox ? [inbox.id] : undefined).catch(() => [])).map((c) => JSON.parse(c.json) as Email);
      return { folders, emails };
    };
    /** Providers that report just what changed: merge those changes into this account's mail only. */
    const syncOne = async (p: MailProvider & { syncChanges: NonNullable<MailProvider["syncChanges"]> }) => {
      const id = p.account.id;
      // The account may be removed (or re-added) while a request is out: then nothing here may land.
      const gone = () => {
        if (providers.get(id) === p) return false;
        dropIfRemoved(id);
        return true;
      };
      setStatus(id, { state: "syncing" });
      let folders: Folder[];
      let ch: SyncChanges;
      try {
        folders = await p.listFolders();
        ch = await p.syncChanges();
        if (gone()) return;
        setStatus(id, { state: "ok", at: Date.now() });
      } catch (err) {
        if (gone()) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[sync] ${id}: ${message}`);
        setStatus(id, { state: "error", error: message, at: Date.now() });
        // Keep showing what we already have; an interrupted first sync has still cached what it fetched.
        const now = get();
        if (now.emails.some((e) => e.accountId === id)) return;
        const cached = await readCache(id, now.folders.filter((f) => f.accountId === id));
        if (gone() || (!cached.folders.length && !cached.emails.length)) return;
        set((s) => ({
          folders: s.folders.some((f) => f.accountId === id) ? s.folders : [...s.folders, ...withPending(cached.folders)],
          emails: mergeByDateDesc(s.emails.filter((e) => e.accountId !== id), cached.emails),
        }));
        return;
      }
      // A full re-sync: replace this account's mail (and only this account's) with its cache.
      const delta = ch.full ? null : ch;
      const full = delta ? null : (await readCache(id, folders)).emails;
      if (gone()) return;
      set((s) => ({
        folders: folders.length ? [...s.folders.filter((f) => f.accountId !== id), ...withPending(folders)] : s.folders,
        emails: delta
          ? (() => {
              // Keep rows the user is changing right now, then drop bodies from what's new.
              const [changed, removed] = protectPending(delta.changed, delta.removed, s.emails, { moving, ...flagging });
              return applyEmailChanges(s.emails, slimIncoming(changed, s), removed);
            })()
          : mergeByDateDesc(s.emails.filter((e) => e.accountId !== id), slimIncoming(full ?? [], s)),
      }));
    };
    const others = real.filter((p) => !p.syncChanges);
    await Promise.all([
      ...real.flatMap((p) => (p.syncChanges ? [syncOne(p as Parameters<typeof syncOne>[0])] : [])),
      (async () => {
        if (!others.length) return;
        const result = await syncMail(others);
        // Leave out accounts removed while their sync ran.
        const live = new Set(others.filter((p) => providers.get(p.account.id) === p).map((p) => p.account.id));
        for (const p of others) if (!live.has(p.account.id)) dropIfRemoved(p.account.id);
        const folders = result.folders.filter((f) => live.has(f.accountId));
        const emails = result.emails.filter((e) => live.has(e.accountId));
        if (emails.length || folders.length) {
          const ids = new Set([...emails.map((e) => e.accountId), ...folders.map((f) => f.accountId)]);
          set((s) => ({
            folders: [...s.folders.filter((f) => !ids.has(f.accountId)), ...withPending(folders)],
            emails: [...s.emails.filter((e) => !ids.has(e.accountId)), ...emails].sort((a, b) => b.date.localeCompare(a.date)),
          }));
        }
      })(),
    ]);
    void syncCalendars([...calProviders.values()]);
    const skip = await applyAutoRules();
    applyLaneRules();
    await get().sort({ onlyNew: true, skip });
  };

  /** Inbox mail of an account that's in the store. */
  const inboxCount = (accountId: string) => {
    const { emails, folders } = get();
    const inbox = inboxFolderIds(folders);
    return emails.reduce((n, e) => n + (e.accountId === accountId && inbox.has(e.folderId) ? 1 : 0), 0);
  };

  const setBackfill = (accountId: string, b: BackfillState) => set((s) => ({ backfill: { ...s.backfill, [accountId]: b } }));

  /** Page through one account's whole Inbox, sorting each page; resumes from the saved cursor. */
  const backfillAccount = async (p: MailProvider) => {
    const id = p.account.id;
    const key = `backfill.${id}`;
    const saved = await kvGet<{ next?: string; done?: boolean }>(key).catch(() => null);
    if (saved?.done) return;
    let cursor = saved?.next;
    let total: number | undefined;
    // True only for the first request from a saved cursor (which may have gone stale).
    let resuming = !!cursor;
    // The earliest page with mail that couldn't be cached whole: the saved resume point
    // stays there (and never becomes done) so next session lists it again.
    let hold: { cursor?: string } | null = null;
    setBackfill(id, { loaded: inboxCount(id), running: true });
    try {
      for (;;) {
        let page: Awaited<ReturnType<NonNullable<MailProvider["backfillInbox"]>>>;
        try {
          page = await p.backfillInbox!(cursor);
        } catch (err) {
          if (!resuming || !staleCursorError(err)) throw err;
          // The saved page token expired: start this account over from the top, once.
          console.warn(`[backfill] ${id}: saved cursor rejected, starting over`);
          resuming = false;
          cursor = undefined;
          await kvSet(key, {});
          continue;
        }
        resuming = false;
        if (providers.get(id) !== p) break; // account removed meanwhile
        total = page.total ?? total;
        const have = new Set(get().emails.map((e) => e.id));
        const fresh: Email[] = [];
        for (const e of page.emails) {
          if (have.has(e.id)) continue;
          have.add(e.id);
          fresh.push(e);
        }
        if (fresh.length) set((s) => ({ emails: mergeByDateDesc(s.emails, slimIncoming(fresh, s)) }));
        setBackfill(id, { loaded: inboxCount(id), total, running: true });
        if (fresh.length) {
          const skip = await applyAutoRules();
          applyLaneRules();
          await get().sort({ onlyNew: true, skip });
        }
        if (page.failed && !hold) hold = { cursor };
        cursor = page.next;
        await kvSet(key, hold ? (hold.cursor ? { next: hold.cursor } : {}) : cursor ? { next: cursor } : { done: true });
        if (!cursor) break;
        await new Promise((r) => setTimeout(r, BACKFILL_PAUSE_MS));
      }
      setBackfill(id, { loaded: inboxCount(id), total, running: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[backfill] ${id}: ${message}`);
      // Stop this account for the session; the saved cursor resumes it next launch.
      setBackfill(id, { loaded: inboxCount(id), total, running: false, error: message });
    }
  };

  /**
   * After a successful refresh: backfill each synced account's Inbox once per session,
   * one account at a time. A refresh while it runs leaves it alone.
   */
  const startBackfill = () => {
    if (backfilling) return;
    const { accountStatus } = get();
    const todo = [...providers.values()].filter(
      (p) => p.account.kind !== "mock" && p.backfillInbox && !backfillTried.has(p.account.id) && accountStatus[p.account.id]?.state === "ok",
    );
    if (!todo.length) return;
    for (const p of todo) backfillTried.add(p.account.id);
    backfilling = (async () => {
      for (const p of todo) if (providers.get(p.account.id) === p) await backfillAccount(p);
    })().finally(() => (backfilling = null));
  };

  const searching = searchActions(set, get);

  return {
    me: ME,
    accounts: [],
    folders: [],
    emails: [],
    triage: {},
    overrides: {},
    laneRuled: {},
    categoryOverrides: {},
    rules: {},
    autoRules: [],
    autoHandled: {},
    habits: new Map(),
    dismissed: new Set(),
    snoozed: {},
    scheduled: [],
    imageSenders: new Set(),
    signatures: [],
    signatureDefaults: {},
    draftSignatures: [],
    sections: [],
    sectionOverrides: {},
    resolved: {},
    lessons: [],
    dateFinds: {},
    noDateSenders: {},
    dateDismissals: {},
    view: { kind: "brief" },
    selectedId: null,
    todayKept: new Set(),
    accountFilter: null,
    checked: new Set(),
    checkAnchor: null,
    bulkSnoozeOpen: false,
    compose: null,
    composeSession: 0,
    composeDirty: false,
    composeView: null,
    composeEdit: null,
    composeCloseAsk: null,
    movePicker: null,
    query: "",
    search: null,
    ...searching.actions,
    sorting: { running: false, done: 0, total: 0 },
    backfill: {},
    calendars: [],
    hiddenCalendars: new Set(),
    events: [],
    calSuggestions: [],
    calChanges: { added: [], deleted: [], resolved: [] },
    accountStatus: {},
    newEvent: null,
    autoReplies: {},

    async load() {
      if (loaded) return;
      loaded = true;
      const accounts = await loadRegistry();
      for (const a of accounts) {
        try {
          providers.set(a.id, mailProviderFor(a));
          const cal = calendarProviderFor(a);
          if (cal) calProviders.set(a.id, cal);
        } catch (err) {
          console.error("[accounts]", a.id, err);
        }
      }
      // Seeded calendar only while a demo (mock) account is connected.
      const hasMock = accounts.some((a) => a.kind === "mock");
      const seed = hasMock ? seedCalendar() : { events: [], suggestions: [] };
      set({
        accounts,
        calendars: hasMock ? CALENDARS : [],
        events: seed.events,
        calSuggestions: seed.suggestions,
      });

      const snap = await kvGet<Snapshot>(SNAPSHOT_KEY).catch(() => null);
      if (snap?.mockOverlay) applyMockOverlay(snap.mockOverlay);
      // Show what's on disk right away (cached mail + saved triage); the network
      // sync afterwards only merges what changed while zMail was closed.
      const local = await syncMail([...providers.values()].filter((p) => p.account.kind === "mock"));
      const cached = await Promise.all(
        accounts
          .filter((a) => a.kind !== "mock")
          .map(async (a) => {
            const folders = (await cacheListFolders(a.id).catch(() => [] as string[])).map((j) => JSON.parse(j) as Folder);
            const inbox = folders.find((f) => f.system === "inbox");
            return {
              folders,
              emails: (await cacheListMessages(a.id, undefined, inbox ? [inbox.id] : undefined).catch(() => [])).map((c) => JSON.parse(c.json) as Email),
            };
          }),
      );
      const folders = [...local.folders, ...cached.flatMap((c) => c.folders)];
      const emails = [...local.emails, ...cached.flatMap((c) => c.emails)].sort((a, b) => b.date.localeCompare(a.date));
      const habits = computeHabits(emails, folders);
      if (snap) restore(snap, habits);
      set({ folders, emails, habits: snap?.habits ? mergeHabits(new Map(snap.habits), habits) : habits });
      void updateMe();
      // Scheduled sends live under their own key (saved on every change, not with the snapshot).
      const scheduled = await kvGet<ScheduledSend[]>(SCHEDULED_KEY).catch(() => null);
      // One left mid-edit at quit is no longer open in a composer: it sends as planned.
      if (scheduled?.length) set({ scheduled: scheduled.filter((r) => accounts.some((a) => a.id === r.accountId)).map(withoutEditing) });
      // Corrections saved before lessons existed: capture their subjects while the mail is still here.
      if (snap && !snap.lessons)
        set({ lessons: lessonsFromOverrides(emails, snap.categoryOverrides ?? {}, snap.sectionOverrides ?? {}, snap.overrides ?? {}) });
      // Bucket moves made before they were kept as lessons: capture them the same way.
      else if (snap?.lessons && !snap.lessons.some((l) => l.bucket) && Object.keys(snap.overrides ?? {}).length)
        set((s) => ({ lessons: capLessons([...s.lessons, ...lessonsFromOverrides(emails, {}, {}, snap.overrides ?? {})]) }));
      applyLaneRules();
      startAutosave();
      // After autosave starts, so what ages out at launch is saved.
      settleNeedsYou();
      startAutoRefresh();
      startScheduler();
      // Fetch changes, sync calendars, and sort only mail the model hasn't seen.
      await get().refresh();
      void findDates();
      // Automatic replies for the sidebar reminder; each account on its own so one failure can't affect another.
      void Promise.all(get().accounts.map((a) => get().loadAutoReply(a.id).catch(() => undefined)));
    },

    async refresh() {
      // One refresh at a time: the 2-minute timer and window focus can overlap.
      if (refreshing) return refreshing;
      refreshing = (async () => {
        try {
          await doRefresh();
          settleNeedsYou();
          startBackfill();
        } finally {
          refreshing = null;
          lastRefreshAt = Date.now();
        }
      })();
      return refreshing;
    },

    async addAccount(account) {
      const accounts = [...get().accounts.filter((a) => a.id !== account.id), account];
      await saveRegistry(accounts);
      providers.set(account.id, mailProviderFor(account));
      const cal = calendarProviderFor(account);
      if (cal) calProviders.set(account.id, cal);
      calendarAccountsChanged(account.id);
      set({ accounts });
      const p = providers.get(account.id)!;
      const { folders, emails } = await syncMail([p]);
      // Removed (or replaced) while its first sync ran: leave its mail out.
      if (providers.get(account.id) !== p) return dropIfRemoved(account.id);
      set((s) => ({
        folders: [...s.folders, ...folders],
        emails: [...s.emails, ...emails].sort((a, b) => b.date.localeCompare(a.date)),
        habits: mergeHabits(s.habits, computeHabits(emails, folders)),
      }));
      if (cal) void syncCalendars([cal], { force: true });
      const skip = await applyAutoRules();
      applyLaneRules();
      await get().sort({ onlyNew: true, skip });
    },

    async removeAccount(id) {
      const account = get().accounts.find((a) => a.id === id);
      const accounts = get().accounts.filter((a) => a.id !== id);
      await saveRegistry(accounts);
      providers.delete(id);
      calProviders.delete(id);
      calendarAccountsChanged(id);
      if (account && account.kind !== "mock") await signOut(id).catch(() => undefined);
      // Its cached mail goes too; the deleted ids say which saved results were its.
      const cachedIds = await cacheDeleteAccount(id).catch((err: unknown) => {
        console.error(`[accounts] ${id}: cached mail not deleted`, err);
        return [] as string[];
      });
      const stillMock = accounts.some((a) => a.kind === "mock");
      set((s) => {
        const calendars = s.calendars.filter((c) => c.accountId !== id && (stillMock || !CALENDARS.some((m) => m.id === c.id)));
        const calIds = new Set(calendars.map((c) => c.id));
        const its = new Set([...cachedIds, ...s.emails.filter((e) => e.accountId === id).map((e) => e.id)]);
        const others = <T>(byId: Record<string, T>) => Object.fromEntries(Object.entries(byId).filter(([emailId]) => !its.has(emailId)));
        return {
          accounts,
          folders: s.folders.filter((f) => f.accountId !== id),
          emails: s.emails.filter((e) => e.accountId !== id),
          triage: others(s.triage),
          resolved: others(s.resolved),
          calendars,
          events: s.events.filter((e) => calIds.has(e.calendarId)),
          calSuggestions: stillMock ? s.calSuggestions : [],
          selectedId: null,
        };
      });
      set((s) => {
        const autoReplies = { ...s.autoReplies };
        const accountStatus = { ...s.accountStatus };
        const backfill = { ...s.backfill };
        delete autoReplies[id];
        delete accountStatus[id];
        delete backfill[id];
        return { autoReplies, accountStatus, backfill, draftSignatures: s.draftSignatures.filter((r) => r.accountId !== id) };
      });
      // Its schedules can't send any more (and must not if the account is added back).
      const n = get().scheduled.filter((r) => r.accountId === id).length;
      if (n) {
        setScheduled((l) => l.filter((r) => r.accountId !== id));
        toast(`Dropped ${n} scheduled email${n > 1 ? "s" : ""} from that account`);
      }
    },

    async loadAutoReply(accountId) {
      const p = providers.get(accountId);
      if (!p?.getAutoReply) return;
      let value: AutoReply | "needs-permission" | "error";
      try {
        value = await p.getAutoReply();
      } catch (err) {
        if (err instanceof NeedsPermissionError) value = "needs-permission";
        else {
          console.error("[auto-replies]", accountId, err);
          value = "error";
        }
      }
      // The account may have been removed while the request was out.
      if (!providers.has(accountId)) return;
      set((s) => ({ autoReplies: { ...s.autoReplies, [accountId]: value } }));
    },

    async saveAutoReply(accountId, r) {
      const p = providerFor(accountId);
      if (!p.setAutoReply) throw new Error("This account can't set automatic replies.");
      try {
        await p.setAutoReply(r);
      } catch (err) {
        if (err instanceof NeedsPermissionError) set((s) => ({ autoReplies: { ...s.autoReplies, [accountId]: "needs-permission" } }));
        throw err;
      }
      set((s) => ({ autoReplies: { ...s.autoReplies, [accountId]: r } }));
      await get().loadAutoReply(accountId);
    },

    async send(accountId, msg) {
      await providerFor(accountId).send(msg);
      resolveReplied(msg.replyTo);
    },

    async saveDraft(accountId, msg, draftId) {
      const p = providerFor(accountId);
      if (!p.saveDraft) throw new Error("This account can't save drafts");
      const fingerprint = draftBlockFingerprint(msg.html);
      const res = await p.saveDraft(msg, draftId);
      // Vouches for the signature block just saved, so reopening this draft gives it back (and no one else's).
      // Not for an account removed while the save ran: its entries are gone and stay gone.
      set((s) =>
        s.accounts.some((a) => a.id === accountId)
          ? {
              draftSignatures: fingerprint
                ? rememberDraftSignature(s.draftSignatures, { accountId, draftId: res.draftId, messageId: res.messageId, fingerprint }, draftId)
                : forgetDraftSignatures(s.draftSignatures, accountId, [res.draftId, res.messageId, draftId]),
            }
          : {},
      );
      // Gmail gives each save a new message id: keep a schedule's pointing at the live one.
      if (get().scheduled.some((r) => r.draftId === res.draftId && r.messageId !== res.messageId))
        setScheduled((l) => l.map((r) => (r.draftId === res.draftId ? { ...r, messageId: res.messageId } : r)));
      return res;
    },

    async sendDraft(accountId, msg, draftId) {
      const p = providerFor(accountId);
      if (!p.sendDraft) throw new Error("This account can't save drafts");
      await p.sendDraft(msg, draftId);
      resolveReplied(msg.replyTo);
      // Sent from the composer: a schedule for this draft is done.
      if (get().scheduled.some((r) => r.draftId === draftId)) setScheduled((l) => l.filter((r) => r.draftId !== draftId));
      // Gmail's draft id differs from its message id; the composer's draft email is dropped by either.
      const gone = new Set([draftId, get().compose?.draft?.emailId]);
      set((s) => ({ emails: s.emails.filter((e) => !gone.has(e.id)), draftSignatures: forgetDraftSignatures(s.draftSignatures, accountId, [draftId]) }));
    },

    async deleteDraft(accountId, draftId, messageId) {
      const p = providerFor(accountId);
      if (!p.deleteDraft) throw new Error("This account can't save drafts");
      await p.deleteDraft(draftId);
      // Nothing left to send.
      if (get().scheduled.some((r) => r.draftId === draftId)) setScheduled((l) => l.filter((r) => r.draftId !== draftId));
      const gone = new Set([draftId, messageId]);
      set((s) => ({ emails: s.emails.filter((e) => !gone.has(e.id)), draftSignatures: forgetDraftSignatures(s.draftSignatures, accountId, [draftId, messageId]) }));
    },

    ...scheduledActions(set, get),

    ...calendarActions(set, get),

    async attachmentData(emailId, attachmentId) {
      const e = get().emails.find((x) => x.id === emailId);
      if (!e) throw new Error("Email not found");
      const p = providerFor(e.accountId);
      if (!p.getAttachment) throw new Error("This account can't download attachments yet");
      return p.getAttachment(emailId, attachmentId);
    },

    inlineImages(emailId) {
      const hit = inlineCache.get(emailId);
      if (hit) {
        inlineCache.delete(emailId);
        inlineCache.set(emailId, hit);
        return Promise.resolve(hit);
      }
      const pending = inlineLoads.get(emailId);
      if (pending) return pending;
      const e = get().emails.find((x) => x.id === emailId);
      const load = (async () => {
        const map = new Map<string, string>();
        if (!e) return map;
        try {
          const imgs = (await providers.get(e.accountId)?.inlineImages?.(emailId)) ?? [];
          for (const i of imgs) map.set(i.cid.toLowerCase(), `data:${i.mimeType};base64,${i.base64}`);
          inlineCache.set(emailId, map);
          if (inlineCache.size > INLINE_CACHE) inlineCache.delete(inlineCache.keys().next().value as string);
        } catch (err) {
          console.warn("[inline]", emailId, err);
          map.clear();
        }
        return map;
      })().finally(() => inlineLoads.delete(emailId));
      inlineLoads.set(emailId, load);
      return load;
    },

    async sort(opts) {
      // Never run two sorts at once (they would send the same mail to the model twice). Every
      // waiter re-checks after waking: the first to wake starts its sort and the rest wait on that.
      while (sorting) await sorting.catch(() => {});
      const run: Promise<void> = (async () => {
        const { emails, folders, habits, me, triage, sections, lessons } = get();
        const only = opts?.ids && new Set(opts.ids);
        const inboxIds = inboxFolderIds(folders);
        const scoped = emails
          // A search result held in the store is never sent to the model (see store/held.ts).
          .filter((e) => inboxIds.has(e.folderId) && !held.has(e.id))
          .filter((e) => !only || only.has(e.id))
          .filter((e) => !opts?.skip?.has(e.id));
        // Automatic replies (out of office) are filed by rule, never sent to the model.
        const refile = scoped.filter((e) => isAutoReply(e) && triage[e.id]?.model !== AUTO_REPLY_MODEL);
        if (refile.length)
          set((s) => {
            const next = { ...s.triage };
            for (const e of refile) next[e.id] = autoReplyTriage(e.id);
            return { triage: next };
          });
        const inbox = scoped
          .filter((e) => !isAutoReply(e))
          .filter((e) => !opts?.onlyNew || !triage[e.id])
          .filter((e) => !opts?.staleSections || (triage[e.id]?.sectionsKey ?? "") !== sectionsKey(sections, e.accountId));
        const provider = decisionProvider();
        set({ sorting: { running: true, done: 0, total: inbox.length, model: provider.name } });
        // Results are buffered and applied together at most every TRIAGE_FLUSH_MS, so a
        // backlog of thousands doesn't re-render Today and Triage once per email.
        let buffer: Triage[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let flushedAt = 0;
        const flush = () => {
          clearTimeout(timer);
          timer = undefined;
          flushedAt = Date.now();
          if (!buffer.length) return;
          const batch = buffer;
          buffer = [];
          set((s) => {
            const triage = { ...s.triage };
            for (const t of batch) triage[t.emailId] = t;
            return { triage, sorting: { ...s.sorting, done: s.sorting.done + batch.length, model: batch[batch.length - 1].model } };
          });
        };
        const onResult = (t: Triage) => {
          buffer.push(t);
          const wait = flushedAt + TRIAGE_FLUSH_MS - Date.now();
          if (wait <= 0) flush();
          else timer ??= setTimeout(flush, wait);
        };
        try {
          const examples =
            lastExamples && lastExamples.emails === emails && lastExamples.lessons === lessons && lastExamples.sections === sections
              ? lastExamples.result
              : (lastExamples = { emails, lessons, sections, result: senderExamples(held.size ? emails.filter((e) => !held.has(e.id)) : emails, lessons, sections) }).result;
          const r = await triageAll(provider, inbox, { me, folders, habits, sections, examples }, onResult);
          flush();
          // Every email failing is a failed sort; some failing keeps the rest and counts the misses.
          const error = r.lastError ?? "Sorting failed";
          if (r.failed && !r.done) set((s) => ({ sorting: { ...s.sorting, running: false, error } }));
          else set((s) => ({ sorting: { ...s.sorting, running: false, at: Date.now(), failed: r.failed ? { count: r.failed, error } : undefined } }));
        } catch (err) {
          flush();
          set((s) => ({ sorting: { ...s.sorting, running: false, error: String(err) } }));
        }
        void findDates(inbox.map((e) => e.id));
      })().finally(() => {
        if (sorting === run) sorting = null;
      });
      sorting = run;
      return run;
    },

    resortSendersOf(ids) {
      const s = get();
      const corrected = new Set(ids);
      const senders = new Set(s.emails.filter((e) => corrected.has(e.id)).map((e) => e.from.address.toLowerCase()));
      const pick = (st: MailState, from: Set<string>, skip: Set<string>) => {
        const inboxIds = inboxFolderIds(st.folders);
        const per = new Map<string, number>();
        return st.emails
          .filter((e) => inboxIds.has(e.folderId) && !skip.has(e.id) && from.has(e.from.address.toLowerCase()))
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
          .filter((e) => {
            const k = e.from.address.toLowerCase();
            const n = (per.get(k) ?? 0) + 1;
            per.set(k, n);
            return n <= RESORT_PER_SENDER;
          })
          .map((e) => e.id);
      };
      const count = pick(s, senders, corrected).length;
      if (!count) return 0;
      for (const x of senders) resort.senders.add(x);
      for (const id of ids) resort.corrected.add(id);
      clearTimeout(resort.timer);
      resort.timer = setTimeout(() => {
        const { senders: from, corrected: skip } = resort;
        resort = { senders: new Set(), corrected: new Set() };
        // Read the inbox again: mail may have been archived or moved during the wait.
        const later = pick(get(), from, skip);
        if (later.length) void get().sort({ ids: later });
      }, RESORT_DELAY_MS);
      return count;
    },

    // Always a new object, so picking the current view again still reads as a view change (it leaves an assistant set).
    setView: (view) => {
      // Unsaved composer text is never dropped silently: ask first; Keep editing stays on this view.
      if (get().compose && get().composeDirty) return get().closeCompose(() => get().setView(view));
      endCloseAsk();
      releaseEditing(get().compose?.draft?.id);
      const reset = { view: { ...view }, selectedId: null, compose: null, checked: new Set<string>(), checkAnchor: null, todayKept: new Set<string>() };
      const s = get();
      const on = resultsMode({ query: s.query, view });
      // Calendar and Scheduled filter as before: search mode ends there (the box keeps its text).
      if (s.search && !on) return searching.leave(reset, false);
      // Picking another view while searching keeps the results; clearing then comes back to that view.
      const origin = { selectedId: null, checked: new Set<string>(), todayKept: new Set<string>() };
      set({ ...reset, ...(on ? { search: s.search ? { ...s.search, origin } : { scope: "all" as const, origin, results: null } } : {}) });
      searching.run();
    },
    async updateAccount(id, patch) {
      const accounts = get().accounts.map((a) => (a.id === id ? { ...a, ...patch } : a));
      set({ accounts });
      await saveRegistry(accounts);
    },
    setAccountFilter: (accountFilter) => {
      set({ accountFilter, checked: new Set(), checkAnchor: null, selectedId: null, todayKept: new Set() });
      searching.run();
    },
    toggleCheck(id) {
      get().adoptResults([id]);
      set((s) => {
        const checked = new Set(s.checked);
        if (checked.has(id)) checked.delete(id);
        else checked.add(id);
        return { checked, checkAnchor: id };
      });
    },
    checkRange(id, order) {
      // With nothing ticked yet, the range starts at the open email, as in Mail and Finder.
      const { checkAnchor, checked, selectedId } = get();
      const anchor = checkAnchor ?? (checked.size ? null : selectedId);
      const a = anchor ? order.indexOf(anchor) : -1;
      const b = order.indexOf(id);
      const ids = a < 0 || b < 0 ? [id] : order.slice(Math.min(a, b), Math.max(a, b) + 1);
      get().adoptResults(ids);
      set((s) => ({ checked: new Set([...s.checked, ...ids]), checkAnchor: id }));
    },
    setChecked: (ids) => {
      get().adoptResults(ids);
      set({ checked: new Set(ids), checkAnchor: ids.at(-1) ?? null });
    },
    clearChecked: () => set({ checked: new Set(), checkAnchor: null, bulkSnoozeOpen: false }),
    setBulkSnoozeOpen: (bulkSnoozeOpen) => set({ bulkSnoozeOpen }),
    select: (id) => {
      // Unsaved composer text is never dropped silently: ask first, then come back here.
      if (get().compose && get().composeDirty) return get().closeCompose(() => get().select(id));
      // A search result that isn't loaded opens like any email once it's in the store.
      if (id) get().adoptResults([id]);
      const s = get();
      const e = id ? s.emails.find((x) => x.id === id) : undefined;
      if (e && s.folders.find((f) => f.id === e.folderId)?.system === "drafts") {
        // A scheduled draft opens like Edit: with its time, and held from the scheduler while open.
        const r = s.scheduled.find((x) => x.messageId === e.id || x.draftId === e.id);
        if (r) void get().editScheduled(r.id).catch((err) => toast.error("Couldn't open the draft", { description: err instanceof Error ? err.message : String(err) }));
        else void get().openDraft(e.id);
        return;
      }
      endCloseAsk();
      releaseEditing(s.compose?.draft?.id);
      // Opened on Today: keep it in place (it's about to be marked read) so K can come back to it.
      const keep = !!e && s.view.kind === "brief" && isInbox(s, e) && !s.todayKept.has(e.id);
      set({ selectedId: id, compose: null, composeDirty: false, composeCloseAsk: null, ...(keep ? { todayKept: new Set(s.todayKept).add(e.id) } : {}) });
      if (e?.unread) openedUnread(e.id, markOpened, isOpen);
    },
    setComposeDirty: (composeDirty) => set({ composeDirty }),
    setComposeView: (composeView) => set({ composeView }),
    editCompose: (patch, session) => set((s) => ({ composeEdit: { ...patch, seq: (s.composeEdit?.seq ?? 0) + 1, session: session ?? s.composeSession } })),
    setComposeCloseAsk: (composeCloseAsk) => set({ composeCloseAsk }),
    closeCompose: (then, cancel) => {
      if (get().composeDirty) {
        endCloseAsk();
        return set({ composeCloseAsk: { then: then ?? (() => {}), cancel } });
      }
      void get().openCompose(null);
      then?.();
    },
    async openDraft(emailId, opts) {
      try {
        const ref = get().emails.find((x) => x.id === emailId);
        if (!ref) throw new Error("That draft no longer exists.");
        const e = await get().ensureEmail({ id: ref.id, accountId: ref.accountId });
        const p = providerFor(e.accountId);
        const id = opts?.draftId ?? (await p.draftIdFor?.(e.id)) ?? e.id;
        // The signature zMail saved with it keeps its own formatting and images; the body is cleaned like any body.
        // What follows the signature (a reply's quoted original) isn't edited: the provider puts it back under our
        // text on save. A provider that can't do that gets the whole draft as the body.
        const block = e.html ? splitSavedSignature(e.html) : null;
        // Only a block zMail saved in this very draft is the user's signature. Any other (one quoted from someone
        // else's email by an app whose quote zMail can't spot) stays in the body, like a draft from any other app.
        const found = block && isOwnDraftSignature(get().draftSignatures, e.accountId, [id, e.id], block.signature) ? block : null;
        const split = found?.quote && !p.keepDraftQuote ? null : found;
        if (split?.quote) p.keepDraftQuote?.(id, split.quote);
        else p.forgetDraftQuote?.(id);
        const files: NonNullable<Compose["attachments"]> = [];
        for (const a of (e.attachments ?? []).filter((x) => !x.inline)) {
          files.push({ filename: a.filename, mimeType: a.mimeType, size: a.size, base64: await get().attachmentData(e.id, a.id) });
        }
        const images = split && /cid:/i.test(split.signature) ? ((await p.inlineImages?.(e.id).catch(() => [])) ?? []) : [];
        const signatureHtml = split ? restoreSignature(split.signature, images) : "";
        const body = split ? cleanBodyHtml(split.body) : e.html ? cleanBodyHtml(e.html) : textToBodyHtml(e.text);
        get().openCompose({
          mode: "blank",
          fromAccountId: e.accountId,
          draft: { id, emailId: e.id },
          prefill: { to: e.to.map((c) => c.address).join(", "), cc: (e.cc ?? []).map((c) => c.address).join(", "), bcc: (e.bcc ?? []).map((c) => c.address).join(", "), subject: e.subject, body, bodyIsHtml: true },
          attachments: files,
          ...(opts?.scheduledAt !== undefined && { scheduledAt: opts.scheduledAt }),
          ...(signatureHtml && { signatureHtml }),
        });
        return true;
      } catch (err) {
        toast.error("Couldn't open the draft", { description: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },
    openCompose: (compose) => {
      const cur = get();
      // A message with unsaved changes is never replaced silently: ask first (Save, Discard or Keep editing).
      if (compose && cur.compose && compose !== cur.compose && cur.composeDirty)
        return new Promise((resolve) => cur.closeCompose(() => void get().openCompose(compose).then(resolve), () => resolve("kept")));
      if (!compose) endCloseAsk();
      // The composer leaves a scheduled draft it was editing: it sends at its time.
      const was = cur.compose?.draft?.id;
      if (compose?.draft?.id !== was) releaseEditing(was);
      const seq = ++composeSeq;
      composeLoading = false;
      const open = (): ComposeOpened => {
        if (seq !== composeSeq) return "replaced";
        composeLoading = false;
        set((s) => ({
          compose,
          // Reopening the same compose object keeps its session, as the composer does.
          composeSession: compose === s.compose ? s.composeSession : seq,
          selectedId: compose ? null : s.selectedId,
          ...(compose ? {} : { composeDirty: false, composeCloseAsk: null, composeView: null, composeEdit: null }),
        }));
        return "opened";
      };
      // The forward quote and AI reply read the email's body: load it first (a local cache read).
      const replyTo = compose?.replyTo;
      if (!replyTo || !get().emails.find((e) => e.id === replyTo)?.bodyTrimmed) return Promise.resolve(open());
      composeLoading = true;
      return get()
        .ensureBody(replyTo)
        .catch(() => undefined)
        .then(open);
    },
    openMovePicker: (movePicker) => set({ movePicker }),
    setQuery: (query) => {
      const s = get();
      const on = resultsMode({ query, view: s.view });
      // Cleared: back to where the search started.
      if (s.search && !on) return searching.leave({ query, todayKept: new Set() }, true);
      if (!s.search && on) set({ query, todayKept: new Set(), search: searching.fresh(), checked: new Set(), checkAnchor: null });
      else set({ query, todayKept: new Set() });
      searching.run();
    },

    ...folderActions(set, get),

    async move(ids, folderId, opts) {
      const want = new Set(ids);
      const list = get().emails.filter((e) => want.has(e.id) && e.folderId !== folderId && !moving.has(e.id));
      if (!list.length) return NOTHING;
      for (const e of list) moving.add(e.id);
      // Off the screen now; the server catches up in batches.
      applyPatches(new Map(list.map((e) => [e.id, { folderId }])));
      try {
        const { failed, error } = await batched(list, (p, part) => p.batchMove(part, folderId));
        const back = new Map<string, Partial<Email>>();
        for (const e of list) if (failed.has(e.id) && get().emails.find((x) => x.id === e.id)?.folderId === folderId) back.set(e.id, { folderId: e.folderId });
        applyPatches(back);
        const done = list.filter((e) => !failed.has(e.id));
        if (opts?.learn !== false && done.length)
          set((s) => {
            const habits = new Map(s.habits);
            for (const e of done) recordFiling(habits, e.from.address, folderId);
            return { habits };
          });
        return { done: done.map((e) => e.id), failed: [...failed], error: failed.size ? (error ?? "The server didn't accept the move.") : undefined };
      } finally {
        for (const e of list) moving.delete(e.id);
      }
    },

    async archive(ids) {
      // Mail in a section with a linked label is filed there instead (in Gmail
      // that's archive + label in one step).
      const s = get();
      const filed = new Map<string, string[]>();
      const rest: string[] = [];
      for (const id of ids) {
        const e = s.emails.find((x) => x.id === id);
        const folderId = e && sectionOf(s, e)?.folderId;
        let target = folderId ? s.folders.find((f) => f.id === folderId && f.accountId === e.accountId) : undefined;
        // A Gmail grouping ("Bills" from "Bills/Visa") can't hold mail: make it a real label first (once;
        // the section is relinked to it). If that fails, archive as usual.
        if (target?.id.includes(":path:")) target = await get().realizeFolder(target.id).catch(() => undefined);
        if (target) filed.set(target.id, [...(filed.get(target.id) ?? []), id]);
        else rest.push(id);
      }
      return mergeResults(
        await Promise.all([...[...filed].map(([folderId, group]) => get().move(group, folderId, { learn: false })), ...(rest.length ? [toSystem(rest, "archive")] : [])]),
      );
    },
    trash: (ids) => toSystem(ids, "trash"),
    spam: (ids) => toSystem(ids, "spam"),

    async ensureEmail(ref) {
      const have = get().emails.find((e) => e.id === ref.id && !e.partial);
      // A listed row has a capped body; the capped text still beats failing outright.
      if (have) return have.bodyTrimmed ? ((await get().ensureBody(have.id).catch(() => have)) ?? have) : have;
      const full = await providerFor(ref.accountId).getMessage(ref.id);
      set((s) => ({ emails: s.emails.some((e) => e.id === full.id) ? s.emails.map((e) => (e.id === full.id ? full : e)) : [...s.emails, full] }));
      return full;
    },

    ensureBody(id) {
      const have = get().emails.find((e) => e.id === id);
      if (!have?.bodyTrimmed) return Promise.resolve(have);
      const pending = bodyLoads.get(id);
      if (pending) return pending;
      const load = (async () => {
        const row = await cacheGetMessage(id).catch(() => null);
        const cached = row ? (JSON.parse(row.json) as Email) : null;
        const full = cached && !cached.bodyTrimmed ? cached : await providerFor(have.accountId).getMessage(id);
        let out: Email | undefined;
        set((s) => {
          const i = s.emails.findIndex((e) => e.id === id);
          if (i < 0 || !s.emails[i].bodyTrimmed) {
            out = s.emails[i];
            return s;
          }
          // Swap in just the body: the store's flags and folder may be newer than the stored row.
          const { bodyTrimmed: _, ...rest } = s.emails[i];
          out = { ...rest, text: full.text, html: full.html };
          const emails = s.emails.slice();
          emails[i] = out;
          const at = loadedBodies.indexOf(id);
          if (at >= 0) loadedBodies.splice(at, 1);
          loadedBodies.push(id);
          while (loadedBodies.length > KEEP_BODIES) {
            const k = loadedBodies.findIndex((x) => x !== s.selectedId && x !== s.compose?.replyTo);
            if (k < 0) break;
            const [old] = loadedBodies.splice(k, 1);
            const j = emails.findIndex((e) => e.id === old);
            if (j >= 0 && !emails[j].bodyTrimmed) emails[j] = slimRow(emails[j]);
          }
          return { emails };
        });
        return out;
      })().finally(() => bodyLoads.delete(id));
      bodyLoads.set(id, load);
      return load;
    },

    async bulkApply(emails, op, opts = {}) {
      const s = get();
      const entry = (e: Email): UndoEntry => ({ id: e.id, accountId: e.accountId, folderId: e.folderId, unread: e.unread, starred: e.starred, labels: e.labels });
      // Record the before-state now: a provider may mutate the very objects passed in.
      const before = new Map(emails.map((e) => [e.id, entry(e)]));
      const accountName = (id: string) => {
        const a = s.accounts.find((x) => x.id === id);
        return a ? (a.label ?? a.name ?? a.address) : id;
      };
      // learn: false (the assistant's uncarded actions) changes only these emails, so Undo has no lesson to put back.
      const teach = opts.learn !== false;
      if (op.kind === "section") {
        const lessonOf = new Map<string, Lesson>();
        for (const l of s.lessons) if ("section" in l && !lessonOf.has(l.emailId)) lessonOf.set(l.emailId, l);
        const undo = emails.map((e) => ({ ...entry(e), section: e.id in s.sectionOverrides ? s.sectionOverrides[e.id] : undefined, ...(teach ? { sectionLesson: lessonOf.get(e.id) } : { untaught: true }) }));
        get().setSection(emails.map((e) => e.id), op.sectionId, { learn: teach });
        opts.onProgress?.(emails.length, emails.length);
        return { done: emails.length, skipped: 0, failed: [], undo };
      }
      if (op.kind === "lane") {
        const lessonOf = new Map<string, Lesson>();
        for (const l of s.lessons) if ("bucket" in l && !lessonOf.has(l.emailId)) lessonOf.set(l.emailId, l);
        const undo = emails.map((e) => ({ ...entry(e), bucket: s.overrides[e.id], bucketRuled: e.id in s.laneRuled, ...(teach ? { bucketLesson: lessonOf.get(e.id) } : { untaught: true }) }));
        get().setBucket(emails.map((e) => e.id), op.lane, { learn: teach });
        opts.onProgress?.(emails.length, emails.length);
        return { done: emails.length, skipped: 0, failed: [], undo };
      }
      const failed: Email[] = [];
      const reasons = new Set<string>();
      let skipped = 0;
      const jobs: BulkJob[] = [];
      for (const [accountId, list] of groupBy(emails, (e) => e.accountId)) {
        const p = providers.get(accountId);
        let target: string | undefined;
        if (op.kind === "move") {
          const f = s.folders.find((x) => x.id === op.folderId);
          if (!f || f.accountId !== accountId) {
            failed.push(...list);
            reasons.add(f ? `That folder belongs to another account, so ${accountName(accountId)} emails weren't moved.` : "That folder no longer exists.");
            continue;
          }
          target = f.id;
        } else if (op.kind === "archive" || op.kind === "trash" || op.kind === "spam") {
          target = sysFolder(s.folders, accountId, op.kind)?.id;
          if (!target) {
            failed.push(...list);
            reasons.add(`${accountName(accountId)} has no ${op.kind} folder.`);
            continue;
          }
        }
        if (!p) {
          failed.push(...list);
          reasons.add(`${accountName(accountId)} isn't connected.`);
          continue;
        }
        const pending = list.filter((e) =>
          op.kind === "read" ? e.unread === op.read : op.kind === "star" ? e.starred !== op.starred : e.folderId !== target,
        );
        skipped += list.length - pending.length;
        for (const part of chunk(pending, p.batchSize))
          jobs.push({
            accountId,
            emails: part,
            run: (prov, es) =>
              op.kind === "read"
                ? prov.batchSetRead(es.map((e) => e.id), op.read)
                : op.kind === "star"
                  ? prov.batchSetStarred(es.map((e) => e.id), op.starred)
                  : prov.batchMove(es, target!),
          });
      }
      /** Gmail keeps folders as labels; track them so a later action's Undo records the truth. */
      const gmailLabels = (e: Email, target: string | undefined): Partial<Email> => {
        if (!target || s.accounts.find((a) => a.id === e.accountId)?.kind !== "gmail") return {};
        const labels = before.get(e.id)?.labels ?? e.labels ?? [];
        try {
          const { add, remove } = labelChangesForMove(e.accountId, labels, target);
          return { labels: [...labels.filter((l) => !remove.includes(l)), ...add.filter((l) => !labels.includes(l))] };
        } catch {
          return {};
        }
      };
      const undo: UndoEntry[] = [];
      const patch = new Map<string, Partial<Email>>();
      // Progress counts only mail actually done or skipped, so a stopped run never looks complete.
      const upfront = skipped;
      const res = await runBulk(jobs, emails.length, { ...opts, onProgress: (n) => opts.onProgress?.(upfront + n, emails.length) }, (e) => {
        undo.push(before.get(e.id) ?? entry(e));
        const target = op.kind === "move" ? op.folderId : op.kind === "read" || op.kind === "star" ? undefined : sysFolder(get().folders, e.accountId, op.kind)?.id;
        if (op.kind === "read") patch.set(e.id, { unread: !op.read });
        else if (op.kind === "star") patch.set(e.id, { starred: op.starred });
        else patch.set(e.id, { folderId: target, ...gmailLabels(e, target) });
      });
      applyPatches(patch);
      opts.onProgress?.(skipped + res.skipped + res.done, emails.length);
      const error = [...(res.error ? [res.error] : []), ...reasons].join(" ") || undefined;
      return { done: res.done, skipped: skipped + res.skipped, failed: [...failed, ...res.failed], undo, error };
    },

    async bulkUndo(undo, op) {
      if (op.kind === "section") {
        const ids = new Set(undo.filter((u) => !u.untaught).map((u) => u.id));
        set((s) => {
          const next = { ...s.sectionOverrides };
          for (const u of undo) {
            if (u.section === undefined) delete next[u.id];
            else next[u.id] = u.section;
          }
          // Forget what the action taught, and put back any lesson it replaced.
          const restored = undo.flatMap((u) => (u.sectionLesson ? [u.sectionLesson] : []));
          const lessons = [...s.lessons.filter((l) => !(ids.has(l.emailId) && "section" in l)), ...restored];
          return { sectionOverrides: next, lessons };
        });
        return { done: undo.length, skipped: 0, failed: [], undo: [] };
      }
      if (op.kind === "lane") {
        const ids = new Set(undo.filter((u) => !u.untaught).map((u) => u.id));
        set((s) => {
          const overrides = { ...s.overrides };
          const laneRuled = { ...s.laneRuled };
          for (const u of undo) {
            if (u.bucket === undefined) delete overrides[u.id];
            else overrides[u.id] = u.bucket;
            if (u.bucketRuled && u.bucket !== undefined) laneRuled[u.id] = u.bucket;
            else delete laneRuled[u.id];
          }
          // Forget what the action taught, and put back any lesson it replaced.
          const restored = undo.flatMap((u) => (u.bucketLesson ? [u.bucketLesson] : []));
          const lessons = [...s.lessons.filter((l) => !(ids.has(l.emailId) && "bucket" in l)), ...restored];
          return { overrides, laneRuled, lessons };
        });
        return { done: undo.length, skipped: 0, failed: [], undo: [] };
      }
      const stub = (u: UndoEntry): Email => ({ id: u.id, accountId: u.accountId, folderId: u.folderId, labels: u.labels ?? [] }) as unknown as Email;
      const jobs: BulkJob[] = [];
      const unreachable: Email[] = [];
      const flagOp = op.kind === "read" || op.kind === "star";
      // Labels are only trusted when they agree with the folder the email was recorded in.
      const trusted = (u: UndoEntry) =>
        !!providers.get(u.accountId)?.restoreLabels &&
        !!u.labels &&
        folderForLabels(u.accountId, u.labels, (l) => (l.startsWith("Label_") ? `${u.accountId}:${l}` : undefined)) === u.folderId;
      const groups = groupBy(undo, (u) => (flagOp ? u.accountId : trusted(u) ? `${u.accountId}\u0000restore` : `${u.accountId}\u0000${u.folderId}`));
      for (const list of groups.values()) {
        const { accountId, folderId } = list[0];
        const restore = !flagOp && trusted(list[0]);
        const p = providers.get(accountId);
        if (!p) {
          unreachable.push(...list.map(stub));
          continue;
        }
        for (const part of chunk(list.map(stub), p.batchSize))
          jobs.push({
            accountId,
            emails: part,
            run: (prov, es) =>
              op.kind === "read"
                ? prov.batchSetRead(es.map((e) => e.id), !op.read)
                : op.kind === "star"
                  ? prov.batchSetStarred(es.map((e) => e.id), !op.starred)
                  : restore && prov.restoreLabels
                    ? prov.restoreLabels(es.map((e) => ({ id: e.id, labels: e.labels })))
                    : prov.batchMove(es, folderId),
          });
      }
      const byId = new Map(undo.map((u) => [u.id, u]));
      const patch = new Map<string, Partial<Email>>();
      const res = await runBulk(jobs, undo.length, {}, (e) => {
        const u = byId.get(e.id)!;
        // Put back only what the action changed.
        patch.set(e.id, op.kind === "read" ? { unread: u.unread } : op.kind === "star" ? { starred: u.starred } : { folderId: u.folderId, ...(!flagOp && trusted(u) ? { labels: u.labels } : {}) });
      });
      applyPatches(patch);
      return {
        ...res,
        failed: [...unreachable, ...res.failed],
        error: res.error ?? (unreachable.length ? "Some accounts aren't connected, so those emails weren't restored." : undefined),
        undo: [],
      };
    },

    snooze(ids, until) {
      let opened: string | null = null;
      set((s) => {
        const snoozed = { ...s.snoozed, ...Object.fromEntries(ids.map((id) => [id, until])) };
        const selectedId = s.selectedId && ids.includes(s.selectedId) ? followSelection(s, { ...s, snoozed }) : s.selectedId;
        if (selectedId && selectedId !== s.selectedId) opened = selectedId;
        // The next email may be a search result that isn't loaded yet.
        const emails = opened ? adoptInto(s.emails, s.search, [opened]) : s.emails;
        return { snoozed, selectedId, emails, checked: new Set([...s.checked].filter((id) => !ids.includes(id))) };
      });
      // Opening the next email counts as opening it, as a click would.
      if (opened && get().emails.find((e) => e.id === opened)?.unread) openedUnread(opened, markOpened, isOpen);
    },

    unsnooze(ids) {
      set((s) => {
        const snoozed = { ...s.snoozed };
        for (const id of ids) delete snoozed[id];
        return { snoozed };
      });
    },

    toggleStar(id) {
      const e = get().emails.find((x) => x.id === id);
      return e ? setFlag([e], "starred", !e.starred) : Promise.resolve(NOTHING);
    },

    setRead(ids, read) {
      settledByHand(ids);
      const want = new Set(ids);
      return setFlag(get().emails.filter((e) => want.has(e.id) && e.unread === read), "unread", !read);
    },

    async acceptSuggestion(ids) {
      const s = get();
      const byFolder = new Map<string, string[]>();
      for (const id of ids) {
        const e = s.emails.find((x) => x.id === id);
        const f = e && (filingRuleFor(s.rules, e.from.address) ?? s.triage[id]?.folder?.folderId);
        if (f) byFolder.set(f, [...(byFolder.get(f) ?? []), id]);
      }
      return mergeResults(await Promise.all([...byFolder].map(([folderId, group]) => get().move(group, folderId))));
    },

    dismissSuggestion(ids) {
      set((s) => ({ dismissed: new Set([...s.dismissed, ...ids]) }));
    },

    setBucket(ids, bucket, opts) {
      set((s) => {
        // A user's choice sticks: it is no longer a lane-rule override.
        const laneRuled = { ...s.laneRuled };
        for (const id of ids) delete laneRuled[id];
        return {
          overrides: { ...s.overrides, ...Object.fromEntries(ids.map((id) => [id, bucket])) },
          laneRuled,
          lessons: opts?.learn === false ? s.lessons : learn(s.lessons, s.emails, ids, { bucket }),
        };
      });
    },

    resolve(ids, why) {
      if (!ids.length) return;
      const at = Date.now();
      set((s) => ({ resolved: { ...s.resolved, ...Object.fromEntries(ids.map((id) => [id, { at, why }])) } }));
      if (why === "done") void get().setRead(ids, true);
    },

    unresolve(ids) {
      if (!ids.some((id) => get().resolved[id])) return;
      set((s) => {
        const resolved = { ...s.resolved };
        for (const id of ids) delete resolved[id];
        return { resolved };
      });
    },

    setCategory(ids, category, opts) {
      set((s) => ({
        categoryOverrides: { ...s.categoryOverrides, ...Object.fromEntries(ids.map((id) => [id, category])) },
        lessons: opts?.learn === false ? s.lessons : learn(s.lessons, s.emails, ids, { category }),
      }));
    },

    addRule(sender, folderId) {
      set((s) => ({ rules: { ...s.rules, [sender.toLowerCase()]: folderId } }));
    },

    addSignature(name, html = "") {
      const id = `sig-${Date.now().toString(36)}`;
      set((s) => ({ signatures: [...s.signatures, { id, name, html }] }));
      return id;
    },

    updateSignature(id, patch) {
      set((s) => ({ signatures: s.signatures.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
    },

    removeSignature(id) {
      set((s) => ({
        signatures: s.signatures.filter((x) => x.id !== id),
        signatureDefaults: Object.fromEntries(
          Object.entries(s.signatureDefaults).map(([a, d]) => [a, { new: d.new === id ? null : d.new, reply: d.reply === id ? null : d.reply }]),
        ),
      }));
    },

    setSignatureDefault(accountId, which, id) {
      set((s) => {
        const cur = s.signatureDefaults[accountId] ?? { new: null, reply: null };
        return { signatureDefaults: { ...s.signatureDefaults, [accountId]: { ...cur, [which]: id } } };
      });
    },

    addAutoRule(input) {
      const from = normalizeFrom(input.from);
      if (!from) throw new Error(`“${input.from}” isn't an email address or domain.`);
      const terms = input.subjectAny?.map((t) => t.trim()).filter(Boolean);
      const rule: AutoRule = {
        id: crypto.randomUUID(),
        match: terms?.length ? { from, subjectAny: terms } : { from },
        action: input.action,
        createdAt: new Date().toISOString(),
        enabled: true,
        hits: 0,
      };
      set((s) => ({ autoRules: [...s.autoRules, rule] }));
      if (isLaneRule(rule)) applyLaneRules();
      return rule;
    },

    setAutoRuleEnabled(id, on) {
      set((s) => ({ autoRules: s.autoRules.map((r) => (r.id === id ? { ...r, enabled: on } : r)) }));
      applyLaneRules();
    },

    removeAutoRule(id) {
      set((s) => ({ autoRules: s.autoRules.filter((r) => r.id !== id) }));
      applyLaneRules();
    },

    applyLaneRules,

    allowImagesFrom(sender) {
      set((s) => ({ imageSenders: new Set([...s.imageSenders, sender.toLowerCase()]) }));
    },

    removeRule(sender) {
      set((s) => {
        const rules = { ...s.rules };
        delete rules[sender];
        return { rules };
      });
    },

    clearOverrides() {
      set({ overrides: {}, laneRuled: {}, sectionOverrides: {}, categoryOverrides: {}, lessons: [] });
    },

    addSection(input) {
      const id = `sec-${Date.now().toString(36)}`;
      set((s) => ({ sections: [...s.sections, { ...input, id }] }));
      return id;
    },

    updateSection(id, patch) {
      set((s) => ({ sections: s.sections.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
      if (patch.dates) void findDates();
    },

    removeSection(id) {
      set((s) => ({
        sections: s.sections.filter((x) => x.id !== id),
        sectionOverrides: Object.fromEntries(Object.entries(s.sectionOverrides).filter(([, v]) => v !== id)),
      }));
    },

    setSection(ids, sectionId, opts) {
      set((s) => ({
        sectionOverrides: { ...s.sectionOverrides, ...Object.fromEntries(ids.map((id) => [id, sectionId])) },
        lessons: opts?.learn === false ? s.lessons : learn(s.lessons, s.emails, ids, { section: sectionId }),
      }));
      void findDates();
    },
  };
});

let macName: Promise<string> | null = null;

/** Who you are (name and address), from your Mac user account and your accounts; see me.ts. */
async function updateMe() {
  macName ??= macUserName();
  const name = await macName;
  const s = useMail.getState();
  const me = deriveMe(s.accounts, s.emails, name);
  if (me.name !== s.me.name || me.address !== s.me.address) useMail.setState({ me });
}

// Connecting or removing an account can change which address is yours.
useMail.subscribe((s, prev) => {
  if (s.accounts !== prev.accounts) void updateMe();
});

// ---- sync helpers ------------------------------------------------------------------

function setStatus(id: string, status: MailState["accountStatus"][string]) {
  // A removed account's late sync doesn't bring its status back.
  if (!useMail.getState().accounts.some((a) => a.id === id)) return;
  useMail.setState((s) => ({ accountStatus: { ...s.accountStatus, [id]: status } }));
}

/**
 * A sync that was under way when its account was removed may have written to the cache after removeAccount
 * cleared it: clear it again. Ids are never reused, so an unregistered id's rows are always orphans.
 */
function dropIfRemoved(id: string) {
  if (useMail.getState().accounts.some((a) => a.id === id)) return;
  void cacheDeleteAccount(id).catch((err: unknown) => console.error(`[accounts] ${id}: cached mail not deleted`, err));
}

/** Fetch folders + messages from each provider; one failing account doesn't block the others. */
async function syncMail(list: MailProvider[]) {
  const results = await Promise.all(
    list.map(async (p) => {
      setStatus(p.account.id, { state: "syncing" });
      try {
        const folders = await p.listFolders();
        const emails = await p.listMessages();
        setStatus(p.account.id, { state: "ok", at: Date.now() });
        return { folders, emails };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[sync] ${p.account.id}: ${message}`);
        setStatus(p.account.id, { state: "error", error: message, at: Date.now() });
        // Keep showing what we already have for this account rather than blanking it.
        const s = useMail.getState();
        const folders = s.folders.filter((f) => f.accountId === p.account.id);
        let emails = s.emails.filter((e) => e.accountId === p.account.id);
        // An interrupted first sync has still cached what it fetched.
        if (!folders.length) folders.push(...(await cacheListFolders(p.account.id).catch(() => [] as string[])).map((j) => JSON.parse(j) as Folder));
        if (!emails.length) {
          const inbox = folders.find((f) => f.system === "inbox");
          emails = (await cacheListMessages(p.account.id, undefined, inbox ? [inbox.id] : undefined).catch(() => [])).map((c) => JSON.parse(c.json) as Email);
        }
        return { folders, emails };
      }
    }),
  );
  const folders = results.flatMap((r) => r.folders);
  const emails = results.flatMap((r) => r.emails).sort((a, b) => b.date.localeCompare(a.date));
  return { folders, emails };
}

function mergeHabits(a: Map<string, SenderHabit>, b: Map<string, SenderHabit>) {
  const out = new Map(a);
  for (const [k, v] of b) if (!out.has(k)) out.set(k, v);
  return out;
}

let refreshStarted = false;
/** When the last refresh finished (ms); focus refreshes within a minute of it are skipped. */
let lastRefreshAt = 0;
const FOCUS_REFRESH_GAP_MS = 60_000;
/** Re-sync real accounts every 2 minutes and when the window regains focus (at most once a minute). */
function startAutoRefresh() {
  if (refreshStarted) return;
  refreshStarted = true;
  const hasReal = () => useMail.getState().accounts.some((a) => a.kind !== "mock");
  setInterval(() => hasReal() && void useMail.getState().refresh(), 120_000);
  window.addEventListener("focus", () => {
    if (Date.now() - lastRefreshAt < FOCUS_REFRESH_GAP_MS) return;
    if (hasReal()) void useMail.getState().refresh();
  });
}

let lastExamples: { emails: Email[]; lessons: Lesson[]; sections: MailSection[]; result: ReturnType<typeof senderExamples> } | null = null;

/** The selection after a change: unchanged while the open email still shows, else the next one. */
function followSelection(before: MailState, after: MailState): string | null {
  const id = before.selectedId;
  if (!id) return id;
  const showing = new Set(orderedEmails(after).map((e) => e.id));
  if (showing.has(id)) return id;
  return nextAfterRemoval(orderedEmails(before).map((e) => e.id), showing, id);
}

/** Fold bulk results into the store: update emails, drop moved ones from selection and checks, re-cache. */
function applyPatches(patch: Map<string, Partial<Email>>) {
  if (!patch.size) return;
  let touched: string[] = [];
  let opened: string | null = null;
  useMail.setState((s) => {
    const counts = countsFor(s, (e) => patch.get(e.id));
    touched = counts.touched;
    const emails = s.emails.map((e) => (patch.has(e.id) ? { ...e, ...patch.get(e.id) } : e));
    const moved = !!s.selectedId && !!patch.get(s.selectedId)?.folderId;
    const selectedId = moved ? followSelection(s, { ...s, emails, folders: counts.folders }) : s.selectedId;
    if (selectedId && selectedId !== s.selectedId) opened = selectedId;
    return {
      folders: counts.folders,
      // The next email may be a search result that isn't loaded yet.
      emails: opened ? adoptInto(emails, s.search, [opened]) : emails,
      selectedId,
      checked: new Set([...s.checked].filter((id) => !patch.get(id)?.folderId)),
    };
  });
  scheduleCountRefresh(touched);
  recache([...patch.keys()]);
  // Opening the next email counts as opening it, as a click would.
  if (opened && useMail.getState().emails.find((e) => e.id === opened)?.unread) openedUnread(opened, markOpened, isOpen);
}

/** Opening an email marks it read when Settings → Appearance → Reading says so (store/read-on-open). */
function markOpened(id: string) {
  void useMail.getState().setRead([id], true);
}
function isOpen(id: string) {
  return useMail.getState().selectedId === id;
}
// Leaving an email is when it counts as read with "When I move on".
useMail.subscribe((s, prev) => {
  if (prev.selectedId && s.selectedId !== prev.selectedId) leftEmail(prev.selectedId, markOpened);
});

// A Today visit's "opened" set ends when the Unread / All switch flips (it reorders the list). Subscribing here
// covers every place that sets todayShow, not just the switch's onClick.
let lastTodayShow = useSettings.getState().todayShow;
useSettings.subscribe((st) => {
  if (st.todayShow === lastTodayShow) return;
  lastTodayShow = st.todayShow;
  if (useMail.getState().todayKept.size) useMail.setState({ todayKept: new Set() });
});
