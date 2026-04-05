import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Cpu, HardDrive, Clock, Zap, Play, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import type { GpuProfile } from "@workspace/api-client-react";

interface ProfileCardProps {
  profile: GpuProfile;
  onLaunch: (profileId: number) => void;
  isLaunching?: boolean;
  volumeStatus?: string;
  hasReadyVolume?: boolean;
}

const PROFILE_TAGLINES: Record<string, string> = {
  starter:
    "Great for solo projects and quick fixes. Expect real-time replies on most coding prompts — about as fast as you can read.",
  standard:
    "Handles large files and multi-component features without breaking stride. Fast enough to feel instant during active development.",
  pro:
    "Full-codebase reasoning at speed. Comfortably architects complex systems, long refactors, and multi-file changes in one shot.",
  ultra:
    "Near-instant output at maximum throughput. Built for demanding agentic pipelines where generation speed is the bottleneck.",
  enterprise:
    "Dedicated cluster capacity for high-volume teams. Parallel sessions with zero contention across the largest models.",
};

function VolumeIndicator({ status }: { status?: string }) {
  if (status === "ready") {
    return (
      <div className="flex items-center gap-1 text-xs text-emerald-400 font-medium">
        <CheckCircle2 className="w-3 h-3" />
        Volume ready — fast start
      </div>
    );
  }
  if (status === "provisioning" || status === "pending") {
    return (
      <div className="flex items-center gap-1 text-xs text-yellow-400 font-medium">
        <Loader2 className="w-3 h-3 animate-spin" />
        Volume provisioning...
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="flex items-center gap-1 text-xs text-red-400 font-medium">
        <AlertCircle className="w-3 h-3" />
        Volume error — set up again
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground/60">
      <HardDrive className="w-3 h-3" />
      No volume — slow cold start
    </div>
  );
}

export function ProfileCard({ profile, onLaunch, isLaunching, volumeStatus, hasReadyVolume }: ProfileCardProps) {
  const tagline = PROFILE_TAGLINES[profile.name] ?? "";
  const startupTime = hasReadyVolume ? profile.startupTimeVolume : profile.startupTimeMin;

  return (
    <Card className="flex flex-col bg-card/50 border-border/50 hover:border-primary/50 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="text-lg font-bold">{profile.displayName}</CardTitle>
            <CardDescription className="font-mono text-xs mt-1">
              {profile.gpuName} x{profile.numGpus} ({profile.totalVram}GB VRAM)
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold text-primary">
              ${profile.estimatedCostMin.toFixed(2)}-${profile.estimatedCostMax.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground">/ hour</div>
          </div>
        </div>
        {tagline && (
          <p className="text-xs text-muted-foreground/80 leading-relaxed mt-2">{tagline}</p>
        )}
      </CardHeader>
      
      <CardContent className="flex-1 space-y-3">
        <div className="grid grid-cols-2 gap-y-3 gap-x-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            <span>{profile.estimatedSpeedMin}-{profile.estimatedSpeedMax} t/s</span>
          </div>
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-primary" />
            <span>{profile.diskSizeGb}GB Disk</span>
          </div>
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-primary" />
            <span>{profile.defaultQuant} ({profile.quantSizeGb}GB)</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            <span>~{startupTime}m start</span>
          </div>
        </div>

        <div className="border-t border-border/30 pt-2">
          <VolumeIndicator status={volumeStatus} />
        </div>
      </CardContent>

      <CardFooter className="pt-4 border-t border-border/50">
        <Button 
          className="w-full font-bold tracking-wide" 
          onClick={() => onLaunch(profile.id)}
          disabled={isLaunching}
          variant={hasReadyVolume ? "default" : "outline"}
        >
          {isLaunching ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> LAUNCHING...</>
          ) : (
            <>
              <Play className="w-4 h-4 mr-2" fill="currentColor" />
              {hasReadyVolume ? "LAUNCH — FAST START" : "LAUNCH SESSION"}
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}
