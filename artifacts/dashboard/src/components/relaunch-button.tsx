import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import {
  useListProfiles,
  cloneSession,
  useCreateSession,
  getGetActiveSessionQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import type { CloneSessionResponse } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { RotateCcw, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { LaunchSessionDialog, type LaunchOptions, type LaunchPrefill } from "@/components/launch-session-dialog";

interface RelaunchButtonProps {
  sessionId: number;
  variant?: "icon" | "default" | "prominent";
  label?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Self-contained "Re-launch" control. On click it fetches the source session's
 * cloneable launch options, looks up the matching GPU profile, and opens the
 * LaunchSessionDialog pre-filled from those options. The user can edit
 * everything before confirming. Confirming creates a brand new session.
 */
export function RelaunchButton({
  sessionId,
  variant = "default",
  label,
  className,
  disabled,
}: RelaunchButtonProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const cloneMutation = useMutation<CloneSessionResponse, Error, number>({
    mutationFn: (id: number) => cloneSession(id),
  });
  const createSession = useCreateSession();
  const { data: profiles } = useListProfiles();

  const [prefill, setPrefill] = useState<LaunchPrefill | null>(null);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);

  const profile = profileId != null ? profiles?.find((p) => p.id === profileId) ?? null : null;

  const handleClick = () => {
    cloneMutation.mutate(
      sessionId,
      {
        onSuccess: (clone: CloneSessionResponse) => {
          // Guard: if the source profile is no longer available (deleted or
          // hidden), don't enter a stuck loading state — surface a clear
          // error and reset.
          const profileExists = !!profiles?.some((p) => p.id === clone.profileId);
          if (!profileExists) {
            toast({
              title: "Profile no longer available",
              description:
                "The GPU profile from the source session can't be found. Pick a profile from the dashboard instead.",
              variant: "destructive",
            });
            setPrefill(null);
            setProfileId(null);
            return;
          }
          setProfileId(clone.profileId);
          setPrefill({
            taskMode: clone.taskMode,
            tokenMode: clone.tokenMode,
            bundleId: clone.bundleId,
            repoUrl: clone.repoUrl,
            intentText: clone.intentText,
            teamMemberNames: clone.teamMemberNames,
            sourceSessionId: clone.sessionId,
          });
        },
        onError: (err: Error) => {
          toast({
            title: "Could not load session",
            description: err?.message || "Failed to fetch the previous session details.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const handleConfirm = (opts: LaunchOptions) => {
    setIsLaunching(true);
    createSession.mutate(
      {
        data: {
          profileId: opts.profileId,
          teamMembers: opts.teamMembers ?? null,
          taskMode: opts.taskMode ?? null,
          tokenMode: opts.tokenMode ?? null,
          bundleId: opts.bundleId ?? null,
          repoUrl: opts.repoUrl ?? null,
          intentText: opts.intentText ?? null,
        },
      },
      {
        onSuccess: (session) => {
          toast({
            title: "Session re-launched",
            description: "Pre-filled from your previous session.",
          });
          queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          setIsLaunching(false);
          setPrefill(null);
          setProfileId(null);
          setLocation(`/sessions/${session.id}`);
        },
        onError: (err: Error) => {
          toast({
            title: "Re-launch failed",
            description: err?.message || "Failed to start a new session.",
            variant: "destructive",
          });
          setIsLaunching(false);
        },
      }
    );
  };

  const handleClose = () => {
    if (isLaunching) return;
    setPrefill(null);
    setProfileId(null);
  };

  const loading = cloneMutation.isPending || (prefill != null && profile == null);

  return (
    <>
      {variant === "icon" ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClick}
          title="Re-launch with these settings"
          aria-label={`Re-launch session ${sessionId} with these settings`}
          disabled={disabled || loading}
          className={className}
          data-testid={`button-relaunch-${sessionId}`}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4 text-primary" />}
        </Button>
      ) : variant === "prominent" ? (
        <Button
          onClick={handleClick}
          disabled={disabled || loading}
          className={`gap-2 ${className ?? ""}`}
          data-testid={`button-relaunch-${sessionId}`}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          {label ?? "Re-launch Session"}
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={handleClick}
          disabled={disabled || loading}
          className={`gap-1.5 ${className ?? ""}`}
          data-testid={`button-relaunch-${sessionId}`}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          {label ?? "Re-launch"}
        </Button>
      )}

      {prefill && profile && (
        <LaunchSessionDialog
          profile={profile}
          prefill={prefill}
          onConfirm={handleConfirm}
          onClose={handleClose}
          isLaunching={isLaunching}
        />
      )}
    </>
  );
}
