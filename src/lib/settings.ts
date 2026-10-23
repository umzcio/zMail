// User settings, persisted locally. API keys live in the macOS Keychain and
// only ever sit in memory here; `partialize` strips them before saving.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { mirroredStorage } from "./web-store";
import type { Bucket, Category } from "@/lib/types";
import { providerType, type ModelInfo, type ProviderGroup, type ProviderTypeId } from "@/lib/ai/catalog";
import { deleteSecret, getSecret, setSecret } from "@/lib/secrets";
import { normalizeBase } from "@/lib/transport";

export type { ProviderGroup } from "@/lib/ai/catalog";

export type ThemeMode = "system" | "light" | "dark" | "translucent";
export type MessageBackground = "theme" | "light";
export type PaletteId = "glacier" | "ember" | "grove" | "aurora" | "mono";
export type Tinted = Category | Bucket;

/** A connected AI provider: an LLM (chat and writing) or a decision model (sorting). */
export interface AiProvider {
  id: string;
  group: ProviderGroup;
  type: ProviderTypeId;
  name: string;
  /** Endpoint as the user entered it (paths are appended per type). */
  baseUrl: string;
  /** Last list from the provider (for Manage models). */
  models: ModelInfo[];
  /** Ids the user turned on. */
  enabledModels: string[];
  /** In memory only; Keychain-backed (never persisted to localStorage). */
  apiKey: string;
}

export interface ModelRef {
  providerId: string;
  model: string;
}

export type AiRole = "assistant" | "writing" | "sorting";
export type AiRoles = Record<AiRole, ModelRef | null>;

export interface NotificationPrefs {
  level: "needs" | "needs_skim" | "off";
  preview: boolean;
  skipWhenFocused: boolean;
  sound: boolean;
  badge: "needs" | "unread" | "none";
  quiet: { on: boolean; from: string; to: string; weekends: "all" | "same" }; // "HH:mm"
  mutedAccounts: string[];
  /** The first-run card was answered (either way). */
  asked: boolean;
}

/** The single-endpoint slots settings v1 had, kept only to find their old Keychain keys. */
export type LegacySlot = "decision" | "generative" | "assistant";

export interface Settings {
  theme: ThemeMode;
  palette: PaletteId;
  /** HTML email background: follow the theme (dark mail in dark mode) or always white. */
  messageBackground: MessageBackground;
  /** Look for dates in all real mail, not just sections with "catch dates" on. */
  findDatesEverywhere: boolean;
  /** Show people's photos from Google contacts and the Microsoft directory. */
  peoplePhotos: boolean;
  /** Use photos from the Mac Contacts app (asks macOS for access when turned on). */
  macContactsPhotos: boolean;
  /** Look up and show company logos for trusted senders. */
  senderLogos: boolean;
  /** Per-category/bucket hue overrides (0–360), on top of the palette. */
  hues: Partial<Record<Tinted, number>>;
  /** Connected AI providers, in the order they were added. */
  aiProviders: AiProvider[];
  /** Which model does each job. The assistant falls back to the writing model when unset. */
  aiRoles: AiRoles;
  /** Providers migrated from v1 whose key may still be under the old slot's Keychain name. Dropped once keys load. */
  legacyKeys?: Record<string, LegacySlot>;
  /** Minimum decision-model confidence before zMail offers a folder move. */
  suggestThreshold: number;
  /** Width in px of the ✦ Assistant side panel (drag its left edge to change). */
  assistantWidth: number;
  /** The sidebar folded to a rail of icons (⌃⌘S). */
  sidebarCollapsed: boolean;
  /** When an opened email counts as read: at once, after markReadDelay seconds open, on moving to another, or only by hand. */
  markRead: MarkRead;
  /** Seconds an email stays open before it counts as read, with markRead "delay". */
  markReadDelay: number;
  /** Today: read mail below a divider ("all") or hidden ("unread"). */
  todayShow: "all" | "unread";
  /** Today's Needs you order: the model's urgency, or by date. */
  needsSort: "urgency" | "newest" | "oldest";
  /** Starting points the assistant can use for drive times. Empty = ask. */
  travelPlaces: { home: string; work: string };
  /** The calendar you picked last for each account's dates and invites (account id → calendar id). */
  defaultCalendars: Record<string, string>;
  /** Web search for the assistant: Claude's built-in search with Anthropic models; otherwise a search service whose key is in the Keychain. */
  webSearch: { builtin: boolean; service: "none" | "brave" | "tavily" };
  /** Banners for new mail zMail sorts into Needs you, and the dock badge. */
  notifications: NotificationPrefs;
}

export type MarkRead = "open" | "delay" | "leave" | "never";

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  setHue: (key: Tinted, hue: number | undefined) => void;
  /** Adds a provider and returns its id. */
  addProvider: (p: Omit<AiProvider, "id">) => string;
  updateProvider: (id: string, patch: Partial<Omit<AiProvider, "id" | "group">>) => void;
  /** Removes a provider, its Keychain key, and any roles that used it. */
  removeProvider: (id: string) => void;
  setRole: (role: AiRole, ref: ModelRef | null) => void;
}

const noRoles = (): AiRoles => ({ assistant: null, writing: null, sorting: null });

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Roles pointing at `providerId` that the predicate rejects become null. */
function pruneRoles(roles: AiRoles, providerId: string, keep: (ref: ModelRef) => boolean): AiRoles {
  const out = { ...roles };
  for (const r of Object.keys(out) as AiRole[]) {
    const ref = out[r];
    if (ref && ref.providerId === providerId && !keep(ref)) out[r] = null;
  }
  return out;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      theme: "system",
      palette: "glacier",
      messageBackground: "theme",
      findDatesEverywhere: true,
      peoplePhotos: true,
      macContactsPhotos: false,
      senderLogos: true,
      hues: {},
      aiProviders: [],
      aiRoles: noRoles(),
      suggestThreshold: 0.7,
      assistantWidth: 340,
      sidebarCollapsed: false,
      markRead: "open",
      markReadDelay: 5,
      todayShow: "all",
      needsSort: "urgency",
      travelPlaces: { home: "", work: "" },
      defaultCalendars: {},
      webSearch: { builtin: true, service: "none" },
      notifications: {
        level: "needs",
        preview: true,
        skipWhenFocused: true,
        sound: false,
        badge: "needs",
        quiet: { on: false, from: "18:00", to: "07:00", weekends: "all" },
        mutedAccounts: [],
        asked: false,
      },
      set: (patch) => set(patch),
      setHue: (key, hue) =>
        set((s) => {
          const hues = { ...s.hues };
          if (hue === undefined) delete hues[key];
          else hues[key] = hue;
          return { hues };
        }),
      addProvider: (p) => {
        const id = newId();
        set((s) => ({ aiProviders: [...s.aiProviders, { ...p, id }] }));
        if (p.apiKey) saveKeySoon(providerKeyName(id), p.apiKey);
        return id;
      },
      updateProvider: (id, patch) => {
        set((s) => {
          const aiProviders = s.aiProviders.map((p) => (p.id === id ? { ...p, ...patch } : p));
          // A model switched off can't keep doing a job.
          const enabled = patch.enabledModels;
          const aiRoles = enabled ? pruneRoles(s.aiRoles, id, (r) => enabled.includes(r.model)) : s.aiRoles;
          return { aiProviders, aiRoles };
        });
        if (patch.apiKey !== undefined) saveKeySoon(providerKeyName(id), patch.apiKey);
      },
      removeProvider: (id) => {
        set((s) => ({ aiProviders: s.aiProviders.filter((p) => p.id !== id), aiRoles: pruneRoles(s.aiRoles, id, () => false) }));
        const name = providerKeyName(id);
        clearTimeout(timers[name]);
        deleteSecret(name).catch((err) => console.error("[secrets] delete failed", err));
      },
      setRole: (role, ref) => set((s) => ({ aiRoles: { ...s.aiRoles, [role]: ref } })),
    }),
    {
      name: "zmail.settings",
      version: 2,
      storage: createJSONStorage(() => mirroredStorage),
      // API keys never touch localStorage; they live in the Keychain.
      partialize: ({ set: _s, setHue: _h, addProvider: _a, updateProvider: _u, removeProvider: _r, setRole: _o, ...rest }) => ({
        ...rest,
        aiProviders: rest.aiProviders.map((p) => ({ ...p, apiKey: "" })),
      }),
      migrate: (persisted, version) => migrateSettings(persisted, version) as unknown as SettingsStore,
    },
  ),
);

// ---- Migration ---------------------------------------------------------------

/** A v1 single-endpoint slot. */
interface LegacyEndpoint {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  models?: ModelInfo[];
}

/**
 * v0 stored { mode: "mock" | "http", url } per endpoint; v1 stored three fixed
 * endpoints (decision, generative, assistant) plus an assistant pick from the
 * writing provider; v2 stores providers and roles.
 */
export function migrateSettings(persisted: unknown, version: number): Record<string, unknown> {
  const st = { ...((persisted ?? {}) as Record<string, unknown>) };
  if (version < 1) {
    for (const k of ["decision", "generative"]) {
      const old = (st[k] ?? {}) as { mode?: string; url?: string; model?: string; apiKey?: string };
      st[k] = {
        provider: old.mode === "http" ? "custom" : "mock",
        baseUrl: (old.url ?? "").replace(/\/v1\/.*$/, ""),
        model: old.model ?? "",
        apiKey: old.apiKey ?? "",
        models: [],
      };
    }
  }
  if (version < 2) {
    const providers: AiProvider[] = [];
    const legacyKeys: Record<string, LegacySlot> = {};
    const roles = noRoles();
    const providerFor = (slot: LegacySlot, e: LegacyEndpoint): AiProvider | null => {
      if (!e.provider || e.provider === "mock" || !e.baseUrl?.trim()) return null;
      const group: ProviderGroup = slot === "decision" ? "decision" : "llm";
      const type = (providerType(group, e.provider) ? e.provider : "custom") as ProviderTypeId;
      const base = normalizeBase(e.baseUrl);
      let p = providers.find((x) => x.group === group && x.type === type && normalizeBase(x.baseUrl) === base);
      if (!p) {
        p = { id: newId(), group, type, name: providerType(group, type)?.label ?? type, baseUrl: e.baseUrl, models: [], enabledModels: [], apiKey: e.apiKey ?? "" };
        providers.push(p);
        legacyKeys[p.id] = slot;
      }
      // Merge model lists, keeping the first copy of each id.
      for (const m of e.models ?? []) if (!p.models.some((x) => x.id === m.id)) p.models.push(m);
      if (!p.apiKey && e.apiKey) p.apiKey = e.apiKey;
      return p;
    };
    const enable = (p: AiProvider, model: string | undefined) => {
      if (model && !p.enabledModels.includes(model)) p.enabledModels.push(model);
    };

    const decision = (st.decision ?? {}) as LegacyEndpoint;
    const generative = (st.generative ?? {}) as LegacyEndpoint;
    const assistant = (st.assistant ?? {}) as LegacyEndpoint;
    const pick = st.assistantPick as { model?: string } | null | undefined;

    const dp = providerFor("decision", decision);
    if (dp) {
      enable(dp, decision.model);
      if (decision.model) roles.sorting = { providerId: dp.id, model: decision.model };
    }
    const gp = providerFor("generative", generative);
    if (gp) {
      enable(gp, generative.model);
      enable(gp, pick?.model);
      if (generative.model) roles.writing = { providerId: gp.id, model: generative.model };
    }
    const ap = providerFor("assistant", assistant);
    if (ap) enable(ap, assistant.model);
    // v1 used the pick only while the writing endpoint was usable (it had a model).
    if (pick?.model && gp && generative.model) roles.assistant = { providerId: gp.id, model: pick.model };
    else if (ap && assistant.model) roles.assistant = { providerId: ap.id, model: assistant.model };

    delete st.decision;
    delete st.generative;
    delete st.assistant;
    delete st.assistantPick;
    st.aiProviders = providers;
    st.aiRoles = roles;
    if (providers.length) st.legacyKeys = legacyKeys;
  }
  return st;
}

// ---- Role resolution ----------------------------------------------------------

export interface ResolvedModel {
  provider: AiProvider;
  model: string;
}

/** A role's provider and model, when the provider still exists, is in the right group and has an endpoint. */
export function resolveRef(s: Pick<Settings, "aiProviders">, ref: ModelRef | null, group: ProviderGroup): ResolvedModel | null {
  if (!ref?.model) return null;
  const provider = s.aiProviders.find((p) => p.id === ref.providerId);
  if (!provider || provider.group !== group || !provider.baseUrl.trim()) return null;
  return { provider, model: ref.model };
}

/** The assistant's model: its own role, else the writing model, else null (offline). */
export function resolveAssistant(s: Pick<Settings, "aiProviders" | "aiRoles">): ResolvedModel | null {
  return resolveRef(s, s.aiRoles.assistant, "llm") ?? resolveRef(s, s.aiRoles.writing, "llm");
}

// ---- Keychain-backed API keys ----------------------------------------------

export const providerKeyName = (id: string) => `apikey.provider.${id}`;
/** Keychain name for a web search service's API key. */
export const webSearchKeyName = (service: "brave" | "tavily") => `apikey.websearch.${service}`;
const timers: Partial<Record<string, ReturnType<typeof setTimeout>>> = {};

function saveKeySoon(name: string, value: string) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => {
    setSecret(name, value).catch((err) => console.error("[secrets] save failed", err));
  }, 400);
}

/**
 * Load each provider's API key from the Keychain into memory. A provider
 * migrated from v1 with no key of its own copies the old slot's key
 * (`apikey.<slot>`, or a pre-Keychain copy from localStorage) once.
 */
export async function hydrateApiKeys() {
  const { aiProviders, legacyKeys } = useSettings.getState();
  let allLoaded = true;
  for (const p of aiProviders) {
    try {
      let apiKey = (await getSecret(providerKeyName(p.id))) ?? "";
      if (!apiKey) {
        const slot = legacyKeys?.[p.id];
        const legacy = (slot ? await getSecret(`apikey.${slot}`) : null) || p.apiKey;
        if (legacy) {
          await setSecret(providerKeyName(p.id), legacy);
          apiKey = legacy;
        }
      }
      useSettings.setState((s) => ({ aiProviders: s.aiProviders.map((x) => (x.id === p.id ? { ...x, apiKey } : x)) }));
    } catch (err) {
      allLoaded = false;
      console.error("[secrets] load failed", err);
    }
  }
  // Keep the map for another try if any load failed.
  if (legacyKeys && allLoaded) useSettings.setState({ legacyKeys: undefined });
}
