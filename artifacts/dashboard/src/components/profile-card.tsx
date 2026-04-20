import { useState } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Cpu, HardDrive, Clock, Zap, Play, Loader2, Users, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import type { GpuProfile } from "@workspace/api-client-react";

interface ProfileCardProps {
  profile: GpuProfile;
  onLaunch: (profileId: number, teamMembers?: string[]) => void;
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
  const [teamOpen, setTeamOpen] = useState(false);
  const [memberNames, setMemberNames] = useState<string[]>([""]);

  const addMember = () => {
    if (memberNames.length < 4) setMemberNames((prev) => [...prev, ""]);
  };

  const removeMember = (i: number) => {
    setMemberNames((prev) => prev.filter((_, idx) => idx !== i));
  };

  const updateMember = (i: number, val: string) => {
    setMemberNames((prev) => prev.map((n, idx) => (idx === i ? val : n)));
  };

  const handleLaunch = () => {
    const validNames = teamOpen
      ? memberNames.map((n) => n.trim()).filter(Boolean)
      : [];
    onLaunch(profile.id, validNames.length > 0 ? validNames : undefined);
  };

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

        {/* Team members collapsible */}
        <div className="border border-border/40 rounded-md overflow-hidden">
          <button
            type="button"
            onClick={() => setTeamOpen((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/20 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              Add team members
              {teamOpen && memberNames.filter(Boolean).length > 0 && (
                <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">
                  {memberNames.filter(Boolean).length}
                </Badge>
              )}
            </span>
            {teamOpen ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>

          {teamOpen && (
            <div className="px-3 pb-3 space-y-2 bg-secondary/10">
              <p className="text-[10px] text-muted-foreground/70 pt-2">
                Each member gets a private IDE with a unique password (up to 4).
              </p>
              {memberNames.map((name, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={name}
                    onChange={(e) => updateMember(i, e.target.value)}
                    placeholder={`Member ${i + 1} name`}
                    className="h-7 text-xs bg-background/50 border-border/50"
                    maxLength={24}
                  />
                  {memberNames.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeMember(i)}
                      className="text-muted-foreground hover:text-destructive shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {memberNames.length < 4 && (
                <button
                  type="button"
                  onClick={addMember}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Plus className="w-3 h-3" /> Add another
                </button>
              )}
            </div>
          )}
        </div>
      </CardContent>

      <CardFooter className="pt-4 border-t border-border/50">
        <Button 
          className="w-full font-bold tracking-wide" 
          onClick={handleLaunch}
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
