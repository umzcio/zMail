// Settings → Notifications: banners for new mail that needs you, the dock badge, quiet hours.

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { useSettings, type NotificationPrefs } from "@/lib/settings";
import { useMail } from "@/lib/store";
import { refreshNotifyStatus, sendTest } from "@/lib/notifications";
import { notifyOpenSettings, notifyRequest, type NotifyStatus } from "@/lib/notify-native";
import { accountColorOf, accountLabel } from "../account-switcher";
import { Group, Row, Segmented } from "./settings-ui";

const time = "selectable h-7 rounded-md border border-hairline bg-[var(--pane)] px-2 text-[12.5px] tabular-nums outline-none focus:ring-2 focus:ring-ring/30";

const STATUS_LABEL: Record<NotifyStatus, string> = {
  authorized: "Allowed",
  provisional: "Allowed",
  denied: "Not allowed",
  notDetermined: "Not asked yet",
  unavailable: "Not available in this build",
};

export function NotificationsPage() {
  const prefs = useSettings((s) => s.notifications);
  const accounts = useMail((s) => s.accounts);
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let live = true;
    void refreshNotifyStatus().then((st) => live && setStatus(st));
    return () => {
      live = false;
    };
  }, []);

  const patch = (p: Partial<NotificationPrefs>) => {
    const st = useSettings.getState();
    st.set({ notifications: { ...st.notifications, ...p } });
  };
  const quietOff = !prefs.quiet.on;
  const setQuiet = (q: Partial<NotificationPrefs["quiet"]>) => patch({ quiet: { ...prefs.quiet, ...q } });
  const allowed = status === "authorized" || status === "provisional";

  const turnOn = async () => {
    setAsking(true);
    try {
      await notifyRequest();
      patch({ asked: true });
      setStatus(await refreshNotifyStatus());
    } finally {
      setAsking(false);
    }
  };

  const link = "font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50";

  return (
    <>
      <p className="mb-4 px-1 text-[12.5px] leading-snug text-foreground/55">
        zMail tells you about new mail it sorts into Needs you. Everything else waits until you look.
      </p>

      <Group>
        <Row label="Notify me about new mail" hint="Only while zMail is open, which it checks every 2 minutes">
          <Segmented
            label="Notify me about new mail"
            value={prefs.level}
            onChange={(level) => patch({ level })}
            options={[
              ["needs", "Needs you"],
              ["needs_skim", "Needs you + Worth a skim"],
              ["off", "Off"],
            ]}
          />
        </Row>
        <Row label="Show a preview" hint="Off: banners say who it's from, not what it says">
          <Switch checked={prefs.preview} onCheckedChange={(preview) => patch({ preview })} aria-label="Show a preview" />
        </Row>
        <Row label="Skip banners while I'm using zMail">
          <Switch checked={prefs.skipWhenFocused} onCheckedChange={(skipWhenFocused) => patch({ skipWhenFocused })} aria-label="Skip banners while I'm using zMail" />
        </Row>
        <Row label="Sound">
          <Switch checked={prefs.sound} onCheckedChange={(sound) => patch({ sound })} aria-label="Sound" />
        </Row>
      </Group>

      <Group title="Dock badge">
        <Row label="Count on the zMail icon">
          <Segmented
            label="Count on the zMail icon"
            value={prefs.badge}
            onChange={(badge) => patch({ badge })}
            options={[
              ["needs", "Needs you"],
              ["unread", "All unread"],
              ["none", "None"],
            ]}
          />
        </Row>
      </Group>

      <Group title="Quiet hours">
        <Row label="No banners during quiet hours" hint="The badge still updates. macOS Focus works too.">
          <Switch checked={prefs.quiet.on} onCheckedChange={(on) => setQuiet({ on })} aria-label="No banners during quiet hours" />
        </Row>
        <Row label="From" disabled={quietOff}>
          <input type="time" value={prefs.quiet.from} disabled={quietOff} onChange={(e) => e.target.value && setQuiet({ from: e.target.value })} className={time} aria-label="Quiet from" />
          <span className="text-[12px] text-foreground/50">to</span>
          <input type="time" value={prefs.quiet.to} disabled={quietOff} onChange={(e) => e.target.value && setQuiet({ to: e.target.value })} className={time} aria-label="Quiet to" />
        </Row>
        <Row label="Weekends" disabled={quietOff}>
          <Segmented
            label="Weekends"
            value={prefs.quiet.weekends}
            disabled={quietOff}
            onChange={(weekends) => setQuiet({ weekends })}
            options={[
              ["all", "Quiet all day"],
              ["same", "Same hours"],
            ]}
          />
        </Row>
      </Group>

      {accounts.length > 0 && (
        <Group title="Accounts">
          {accounts.map((a) => {
            const name = accountLabel(a, accounts);
            const muted = prefs.mutedAccounts.includes(a.id);
            return (
              <Row
                key={a.id}
                label={
                  <span className="flex items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: accountColorOf(a, accounts) }} />
                    <span className="truncate">{name}</span>
                  </span>
                }
              >
                <Switch
                  checked={!muted}
                  onCheckedChange={(on) =>
                    patch({ mutedAccounts: on ? prefs.mutedAccounts.filter((id) => id !== a.id) : [...prefs.mutedAccounts, a.id] })
                  }
                  aria-label={`Notifications for ${name}`}
                />
              </Row>
            );
          })}
        </Group>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11.5px] text-foreground/45">
        <span>macOS permission: {status ? STATUS_LABEL[status] : "…"}</span>
        <button onClick={() => void notifyOpenSettings()} className={link}>
          Open System Settings
        </button>
        {status === "notDetermined" ? (
          <button
            onClick={() => void turnOn()}
            disabled={asking}
            className="h-6 rounded-md bg-primary px-2.5 text-[11.5px] font-semibold text-primary-foreground disabled:opacity-60"
          >
            Turn on notifications
          </button>
        ) : (
          <button onClick={() => void sendTest()} disabled={!allowed} className={link}>
            Send a test notification
          </button>
        )}
      </div>
    </>
  );
}
