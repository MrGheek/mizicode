import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Cpu, HardDrive, Clock, Zap, Play } from "lucide-react";
import type { GpuProfile } from "@workspace/api-client-react";

interface ProfileCardProps {
  profile: GpuProfile;
  onLaunch: (profileId: number) => void;
  isLaunching?: boolean;
}

export function ProfileCard({ profile, onLaunch, isLaunching }: ProfileCardProps) {
  return (
    <Card className="flex flex-col bg-card/50 border-border/50 hover:border-primary/50 transition-colors">
      <CardHeader className="pb-4">
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
      </CardHeader>
      
      <CardContent className="flex-1 grid grid-cols-2 gap-y-3 gap-x-4 text-sm text-muted-foreground">
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
          <span>~{profile.startupTimeMin}m startup</span>
        </div>
      </CardContent>

      <CardFooter className="pt-4 border-t border-border/50">
        <Button 
          className="w-full font-bold tracking-wide" 
          onClick={() => onLaunch(profile.id)}
          disabled={isLaunching}
        >
          {isLaunching ? (
            "LAUNCHING..."
          ) : (
            <>
              <Play className="w-4 h-4 mr-2" fill="currentColor" />
              LAUNCH SESSION
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}
