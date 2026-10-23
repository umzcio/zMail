// Settings → Appearance: theme, message background, people's photos and logos, color scheme.

import { useState } from "react";
import { Check } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { enableMacContacts } from "@/lib/mac-contacts";
import { BUCKETS, CATEGORIES } from "@/lib/types";
import { useSettings, type PaletteId, type ThemeMode, type Tinted } from "@/lib/settings";
import { PALETTES } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { BUCKET_META, CATEGORY_META } from "@/lib/meta";
import { Group, Row, Segmented } from "./settings-ui";
import { MARK_READ_DELAY } from "@/lib/store/read-on-open";

function ThemePreview({ mode }: { mode: ThemeMode }) {
  const dark = mode === "dark";
  const glass = mode === "translucent";
  const half = mode === "system";
  const win = (d: boolean) => (
    <div className={cn("flex h-full gap-1 p-1.5", d ? "bg-[#1b1c21]" : "bg-[#eceef2]")}>
      <div className={cn("w-1/4 space-y-1 rounded-sm p-1", d ? "bg-[#15161a]" : "bg-[#e2e4e9]")}>
        <div className={cn("h-1 w-3/4 rounded-full", d ? "bg-white/20" : "bg-black/15")} />
        <div className={cn("h-1 w-1/2 rounded-full", d ? "bg-white/15" : "bg-black/10")} />
      </div>
      <div className={cn("flex-1 space-y-1 rounded-sm p-1.5", d ? "bg-[#22232a]" : "bg-white")}>
        <div className={cn("h-1.5 w-2/3 rounded-full", d ? "bg-white/30" : "bg-black/25")} />
        <div className={cn("h-1 w-full rounded-full", d ? "bg-white/12" : "bg-black/8")} />
        <div className={cn("h-1 w-5/6 rounded-full", d ? "bg-white/12" : "bg-black/8")} />
        <div className="h-1 w-1/3 rounded-full bg-primary/70" />
      </div>
    </div>
  );
  if (glass)
    return (
      <div className="relative h-full bg-[linear-gradient(135deg,#7aa7ff,#c08bff_60%,#ffb7d5)] p-1.5">
        <div className="flex h-full gap-1 rounded-sm bg-white/35 p-1 backdrop-blur-sm">
          <div className="w-1/4 rounded-sm bg-white/30" />
          <div className="flex-1 space-y-1 rounded-sm bg-white/55 p-1.5">
            <div className="h-1.5 w-2/3 rounded-full bg-black/25" />
            <div className="h-1 w-full rounded-full bg-black/10" />
          </div>
        </div>
      </div>
    );
  if (half)
    return (
      <div className="relative h-full">
        {win(false)}
        <div className="absolute inset-0 [clip-path:polygon(55%_0,100%_0,100%_100%,45%_100%)]">{win(true)}</div>
      </div>
    );
  return win(dark);
}

const HUES = [20, 45, 75, 105, 150, 175, 200, 230, 255, 285, 315, 345];

function HueSwatch({ k, label }: { k: Tinted; label: string }) {
  const s = useSettings();
  const value = s.hues[k] ?? PALETTES[s.palette].hues[k];
  const custom = s.hues[k] !== undefined;
  return (
    <Row label={label} hint={custom ? "Custom" : undefined}>
      <Popover>
        <PopoverTrigger
          render={
            <button
              className="size-6 rounded-full ring-2 ring-[var(--pane)] ring-offset-1 ring-offset-hairline transition hover:scale-110"
              style={{ background: `oklch(0.66 0.16 ${value})` }}
              aria-label={`Color for ${label}`}
            />
          }
        />
        <PopoverContent align="end" className="w-auto rounded-xl p-2.5">
          <div className="grid grid-cols-6 gap-1.5">
            {HUES.map((h) => (
              <button
                key={h}
                onClick={() => s.setHue(k, h)}
                className="grid size-7 place-items-center rounded-full transition hover:scale-110"
                style={{ background: `oklch(0.66 0.16 ${h})` }}
                aria-label={`Hue ${h}`}
              >
                {Math.abs(value - h) < 8 && <Check className="size-3.5 text-white" strokeWidth={3} />}
              </button>
            ))}
          </div>
          {custom && (
            <button onClick={() => s.setHue(k, undefined)} className="mt-2 w-full rounded-md py-1 text-[11.5px] text-foreground/55 hover:bg-foreground/5">
              Reset to scheme
            </button>
          )}
        </PopoverContent>
      </Popover>
    </Row>
  );
}

export function AppearancePage() {
  const s = useSettings();
  const [contactsNote, setContactsNote] = useState<string | null>(null);
  const themes: { value: ThemeMode; label: string }[] = [
    { value: "system", label: "Auto" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "translucent", label: "Glass" },
  ];
  return (
    <>
      <Group title="Theme" footer="Glass lets your desktop show through the window using macOS vibrancy.">
        <div className="grid grid-cols-4 gap-3 p-4">
          {themes.map((t) => (
            <button key={t.value} onClick={() => s.set({ theme: t.value })} className="group text-center">
              <div
                className={cn(
                  "aspect-[4/3] overflow-hidden rounded-lg ring-1 ring-hairline transition",
                  s.theme === t.value ? "ring-[2.5px] ring-primary" : "group-hover:ring-foreground/20",
                )}
              >
                <ThemePreview mode={t.value} />
              </div>
              <div className={cn("mt-1.5 text-[12px]", s.theme === t.value ? "font-semibold" : "text-foreground/60")}>{t.label}</div>
            </button>
          ))}
        </div>
      </Group>

      <Group
        title="Message background"
        footer="Always light shows every email on a white background, even in dark mode. You can also switch one email with the ☀︎ button."
      >
        <Row label="Message background">
          <div className="flex gap-0.5 rounded-lg bg-foreground/[0.06] p-0.5">
            {([["theme", "Match theme"], ["light", "Always light"]] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => s.set({ messageBackground: value })}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[12px] transition",
                  s.messageBackground === value ? "bg-[var(--pane)] font-medium shadow-sm" : "text-foreground/60 hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Show people's photos" hint="From your Google contacts and your organization's Microsoft directory. Kept on this Mac. Never for mail in Junk.">
          <Switch checked={s.peoplePhotos} onCheckedChange={(on) => s.set({ peoplePhotos: on })} aria-label="Show people's photos" />
        </Row>
        <Row label="Use photos from Contacts" hint="Photos you saved in the Contacts app on this Mac. macOS asks for permission the first time.">
          <Switch
            checked={s.macContactsPhotos}
            onCheckedChange={async (on) => {
              setContactsNote(null);
              if (!on) return s.set({ macContactsPhotos: false });
              const result = await enableMacContacts();
              if (result === "granted") s.set({ macContactsPhotos: true });
              else
                setContactsNote(
                  result === "denied"
                    ? "zMail doesn't have access to Contacts. Turn it on in System Settings → Privacy & Security → Contacts."
                    : "Not available in this build.",
                );
            }}
            aria-label="Use photos from Contacts"
          />
        </Row>
        {contactsNote && <div className="px-4 pb-2.5 text-[11.5px] leading-snug text-foreground/45">{contactsNote}</div>}
        <Row label="Show sender logos" hint="For well-known companies, and senders whose images you always load. Looked up once from the company's own domain and kept on this Mac. Never for personal addresses, your own organization, or mail in Junk.">
          <Switch checked={s.senderLogos} onCheckedChange={(on) => s.set({ senderLogos: on })} aria-label="Show sender logos" />
        </Row>
      </Group>

      <Group
        title="Reading"
        footer={
          s.markRead === "never"
            ? "Emails stay unread until you press U or use Mark as read."
            : s.markRead === "leave"
              ? "An email counts as read once you open another one or close it."
              : "Opening an email by accident? Pick a delay, or wait until you move on."
        }
      >
        <Row label="Mark as read">
          <Segmented
            label="Mark as read"
            value={s.markRead}
            onChange={(markRead) => s.set({ markRead })}
            options={[
              ["open", "When opened"],
              ["delay", "After a delay"],
              ["leave", "When I move on"],
              ["never", "Never"],
            ]}
          />
        </Row>
        {s.markRead === "delay" && (
          <Row label="Seconds open before it counts">
            <input
              type="number"
              min={MARK_READ_DELAY.min}
              max={MARK_READ_DELAY.max}
              value={s.markReadDelay}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n) && n >= MARK_READ_DELAY.min && n <= MARK_READ_DELAY.max) s.set({ markReadDelay: n });
              }}
              aria-label="Seconds open before it counts as read"
              className="selectable h-7 w-16 rounded-md bg-foreground/[0.06] px-2 text-right text-[12.5px] tabular-nums outline-none focus:ring-2 focus:ring-ring/40"
            />
          </Row>
        )}
      </Group>

      <Group title="Color scheme" footer="Sets the accent and the colors used for buckets and categories.">
        <div className="grid grid-cols-5 gap-3 p-4">
          {(Object.keys(PALETTES) as PaletteId[]).map((id) => {
            const h = PALETTES[id].hues;
            const c = id === "mono" ? 0.03 : 0.16;
            return (
              <button key={id} onClick={() => s.set({ palette: id, hues: {} })} className="group text-center">
                <div
                  className={cn(
                    "flex h-11 overflow-hidden rounded-lg ring-1 ring-hairline transition",
                    s.palette === id ? "ring-[2.5px] ring-primary" : "group-hover:ring-foreground/20",
                  )}
                >
                  {[h.accent, h.needs_you, h.worth_skim, h.ready_archive].map((x, i) => (
                    <span key={i} className="flex-1" style={{ background: `oklch(0.66 ${c} ${x})` }} />
                  ))}
                </div>
                <div className={cn("mt-1.5 text-[12px]", s.palette === id ? "font-semibold" : "text-foreground/60")}>{PALETTES[id].label}</div>
              </button>
            );
          })}
        </div>
      </Group>

      <Group title="Bucket colors">
        {BUCKETS.map((b) => (
          <HueSwatch key={b} k={b} label={BUCKET_META[b].label} />
        ))}
      </Group>
      <Group title="Category colors">
        {CATEGORIES.map((c) => (
          <HueSwatch key={c} k={c} label={CATEGORY_META[c].label} />
        ))}
      </Group>
    </>
  );
}
