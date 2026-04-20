import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Cpu, HardDrive, Clock, Zap, Play, Loader2 } from "lucide-react";
import type { GpuProfile } from "@workspace/api-client-react";

interface ProfileCardProps {
  profile: GpuProfile;
  onLaunch: (profileId: number) => void;
  isLaunching?: boolean;
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
  "qwen3-coder-standard":
    "Highest SWE-Bench score per dollar. Compact 80B MoE delivers frontier-class code edits on 4× A100 hardware.",
  "qwen3-coder-pro":
    "Qwen3-Coder-Next at maximum throughput on 8× A100. 256K context window ideal for full-repo reasoning and rapid iteration.",
  "minimax-m2-ultra":
    "Top open-weight model on SWE-Bench Verified (80.2%). Fast 229B MoE — fronts like a frontier model, runs on H100 hardware.",
  "glm-5-1-ultra":
    "GLM-5.1 FP8 on 8× H100 with reduced context. Best for shorter agentic tasks where H200 availability is limited.",
  "glm-5-1-h200":
    "Best SWE-Bench Pro score of any open-weight model (58.4%). Full 128K context — the recommended GLM-5.1 configuration.",
  "deepseek-v3-2-h200":
    "671B MIT-licensed model with strong general coding and multi-language reasoning. Great when open licensing is a requirement.",
};

export function ProfileCard({ profile, onLaunch, isLaunching }: ProfileCardProps) {
  const tagline = PROFILE_TAGLINES[profile.name] ?? "";

  return (
    <Card className="flex flex-col bg-card/50 border-border/50 hover:border-primary/50 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-lg font-bold">{profile.displayName}</CardTitle>
              <Badge variant="secondary" className="text-xs font-mono px-1.5 py-0">
                {profile.modelDisplayName}
              </Badge>
            </div>
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
            <span>~{profile.startupTimeMin}m start</span>
          </div>
        </div>
      </CardContent>

      <CardFooter className="pt-4 border-t border-border/50">
        <Button 
          className="w-full font-bold tracking-wide" 
          onClick={() => onLaunch(profile.id)}
          disabled={isLaunching}
          variant="outline"
        >
          {isLaunching ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> LAUNCHING...</>
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
