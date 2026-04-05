import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarClock, Save, Loader2 } from "lucide-react";
import type { GpuProfile, SchedulerConfig } from "@workspace/api-client-react";

const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Moscow",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
  "UTC",
];

const DAYS = [
  { key: "mon", label: "M" },
  { key: "tue", label: "Tu" },
  { key: "wed", label: "W" },
  { key: "thu", label: "Th" },
  { key: "fri", label: "F" },
  { key: "sat", label: "Sa" },
  { key: "sun", label: "Su" },
];

interface SchedulerConfigCardProps {
  config: SchedulerConfig;
  profiles: GpuProfile[];
  onSave: (updates: Partial<SchedulerConfig>) => Promise<void>;
  isSaving?: boolean;
}

export function SchedulerConfigCard({ config, profiles, onSave, isSaving }: SchedulerConfigCardProps) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [profileId, setProfileId] = useState<number | null>(config.profileId ?? null);
  const [timezone, setTimezone] = useState(config.timezone);
  const [launchTime, setLaunchTime] = useState(config.launchTime);
  const [stopTime, setStopTime] = useState(config.stopTime);
  const [secondReminderTime, setSecondReminderTime] = useState(config.secondReminderTime);
  const [daysOfWeek, setDaysOfWeek] = useState<string[]>(config.daysOfWeek);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    setEnabled(config.enabled);
    setProfileId(config.profileId ?? null);
    setTimezone(config.timezone);
    setLaunchTime(config.launchTime);
    setStopTime(config.stopTime);
    setSecondReminderTime(config.secondReminderTime);
    setDaysOfWeek(config.daysOfWeek);
    setIsDirty(false);
  }, [config]);

  const markDirty = () => setIsDirty(true);

  const toggleDay = (day: string) => {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
    markDirty();
  };

  const handleSave = async () => {
    await onSave({ enabled, profileId, timezone, launchTime, stopTime, secondReminderTime, daysOfWeek });
    setIsDirty(false);
  };

  return (
    <Card className="bg-card/50 border-border/50">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CalendarClock className="w-5 h-5 text-primary" />
            <div>
              <CardTitle className="text-lg">Session Scheduler</CardTitle>
              <CardDescription className="mt-0.5">
                Auto-launch a session before your workday and stop it in the evening
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{enabled ? "On" : "Off"}</span>
            <Switch
              checked={enabled}
              onCheckedChange={(v) => { setEnabled(v); markDirty(); }}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {/* Profile */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
              GPU Profile
            </Label>
            <Select
              value={profileId ? String(profileId) : ""}
              onValueChange={(v) => { setProfileId(v ? Number(v) : null); markDirty(); }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select profile…" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Timezone */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
              Timezone
            </Label>
            <Select
              value={timezone}
              onValueChange={(v) => { setTimezone(v); markDirty(); }}
            >
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMON_TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Days of week */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
              Days of Week
            </Label>
            <div className="flex gap-1">
              {DAYS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleDay(key)}
                  className={`w-8 h-8 rounded text-xs font-semibold transition-colors ${
                    daysOfWeek.includes(key)
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground hover:bg-secondary/80"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Launch time */}
          <div className="space-y-2">
            <Label htmlFor="launch-time" className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
              Launch At
            </Label>
            <Input
              id="launch-time"
              type="time"
              value={launchTime}
              onChange={(e) => { setLaunchTime(e.target.value); markDirty(); }}
              className="h-9 font-mono"
            />
            <p className="text-xs text-muted-foreground">Session starts automatically at this time</p>
          </div>

          {/* Stop time */}
          <div className="space-y-2">
            <Label htmlFor="stop-time" className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
              Stop At
            </Label>
            <Input
              id="stop-time"
              type="time"
              value={stopTime}
              onChange={(e) => { setStopTime(e.target.value); markDirty(); }}
              className="h-9 font-mono"
            />
            <p className="text-xs text-muted-foreground">10s countdown shown, hard-kill 2 min later</p>
          </div>

          {/* Second reminder */}
          <div className="space-y-2">
            <Label htmlFor="reminder-time" className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
              Nightly Reminder
            </Label>
            <Input
              id="reminder-time"
              type="time"
              value={secondReminderTime}
              onChange={(e) => { setSecondReminderTime(e.target.value); markDirty(); }}
              className="h-9 font-mono"
            />
            <p className="text-xs text-muted-foreground">Reminder shown before next day's launch</p>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border/40">
          <p className="text-xs text-muted-foreground">
            {enabled && profileId ? (
              <>
                Scheduled: launch {launchTime} · stop {stopTime} · {daysOfWeek.join(", ")} · {timezone.replace(/_/g, " ")}
              </>
            ) : (
              !enabled ? "Scheduler is disabled" : "Select a GPU profile to enable"
            )}
          </p>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className="gap-2"
          >
            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
