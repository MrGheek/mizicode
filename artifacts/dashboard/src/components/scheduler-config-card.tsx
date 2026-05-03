import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CalendarClock, Save, Loader2, UserPlus, X } from "lucide-react";
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

const MAX_TEAM_MEMBERS = 4;
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const RESERVED_NAMES = new Set(["__shared__", "owner", "admin", "root", "shared"]);

function sanitizeMemberName(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase();
  if (!SAFE_NAME_RE.test(cleaned)) return null;
  if (RESERVED_NAMES.has(cleaned)) return null;
  return cleaned;
}

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
  const [teamMemberNames, setTeamMemberNames] = useState<string[]>(config.teamMemberNames ?? []);
  const [newMemberInput, setNewMemberInput] = useState("");
  const [memberInputError, setMemberInputError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    setEnabled(config.enabled);
    setProfileId(config.profileId ?? null);
    setTimezone(config.timezone);
    setLaunchTime(config.launchTime);
    setStopTime(config.stopTime);
    setSecondReminderTime(config.secondReminderTime);
    setDaysOfWeek(config.daysOfWeek);
    setTeamMemberNames(config.teamMemberNames ?? []);
    setIsDirty(false);
  }, [config]);

  const markDirty = () => setIsDirty(true);

  const toggleDay = (day: string) => {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
    markDirty();
  };

  const addMember = () => {
    const sanitized = sanitizeMemberName(newMemberInput);
    if (!sanitized) {
      setMemberInputError("Name must be lowercase letters, numbers, hyphens, or underscores (no spaces).");
      return;
    }
    if (teamMemberNames.includes(sanitized)) {
      setMemberInputError("This name is already in the list.");
      return;
    }
    if (teamMemberNames.length >= MAX_TEAM_MEMBERS) {
      setMemberInputError(`Maximum ${MAX_TEAM_MEMBERS} team members allowed.`);
      return;
    }
    setTeamMemberNames((prev) => [...prev, sanitized]);
    setNewMemberInput("");
    setMemberInputError(null);
    markDirty();
  };

  const removeMember = (name: string) => {
    setTeamMemberNames((prev) => prev.filter((n) => n !== name));
    markDirty();
  };

  const handleMemberKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addMember();
    }
  };

  const handleSave = async () => {
    await onSave({ enabled, profileId, timezone, launchTime, stopTime, secondReminderTime, daysOfWeek, teamMemberNames });
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

        {/* Team Members */}
        <div className="space-y-3 pt-1">
          <div>
            <Label className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
              Team Members
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              Pre-configure up to {MAX_TEAM_MEMBERS} members for collaborative sessions. Each member gets their own IDE workspace and credentials.
            </p>
          </div>

          {teamMemberNames.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {teamMemberNames.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-secondary text-sm font-mono text-foreground"
                >
                  {name}
                  <button
                    type="button"
                    onClick={() => removeMember(name)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={`Remove ${name}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {teamMemberNames.length < MAX_TEAM_MEMBERS && (
            <div className="flex gap-2">
              <div className="flex-1 space-y-1">
                <Input
                  placeholder="e.g. alice"
                  value={newMemberInput}
                  onChange={(e) => { setNewMemberInput(e.target.value); setMemberInputError(null); }}
                  onKeyDown={handleMemberKeyDown}
                  className="h-9 font-mono"
                />
                {memberInputError && (
                  <p className="text-xs text-destructive">{memberInputError}</p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addMember}
                className="h-9 gap-1.5 shrink-0"
                disabled={!newMemberInput.trim()}
              >
                <UserPlus className="w-3.5 h-3.5" />
                Add
              </Button>
            </div>
          )}

          {teamMemberNames.length === 0 && (
            <p className="text-xs text-muted-foreground italic">
              No team members configured — session will launch in solo mode.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border/40">
          <p className="text-xs text-muted-foreground">
            {enabled && profileId ? (
              <>
                Scheduled: launch {launchTime} · stop {stopTime} · {daysOfWeek.join(", ")} · {timezone.replace(/_/g, " ")}
                {teamMemberNames.length > 0 && ` · ${teamMemberNames.length} team member${teamMemberNames.length > 1 ? "s" : ""}`}
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
