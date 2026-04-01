import { useState } from "react";
import { useLocation } from "wouter";
import { useSearchOffers, useListProfiles, useCreateSession, getGetDashboardSummaryQueryKey, getGetActiveSessionQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Server, Zap, HardDrive, DollarSign, Search, Filter } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function Offers() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [profileId, setProfileId] = useState<string>("all");
  const [gpuName, setGpuName] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  
  const { data: profiles } = useListProfiles();
  
  // Use debounced values for search? Or just pass directly if user types
  const searchParams = {
    ...(profileId !== "all" && { profileId: parseInt(profileId) }),
    ...(gpuName && { gpuName }),
    ...(maxPrice && { maxPrice: parseFloat(maxPrice) }),
    limit: 50
  };

  const { data: offers, isLoading, isFetching } = useSearchOffers(searchParams);
  const createSession = useCreateSession();

  const handleRent = (offerId: number) => {
    // Determine profile id to use
    let pId = profileId !== "all" ? parseInt(profileId) : undefined;
    if (!pId && profiles?.length) {
      pId = profiles[0].id; // fallback to first profile
    }

    if (!pId) {
      toast({ title: "Error", description: "Please select a profile first.", variant: "destructive" });
      return;
    }

    createSession.mutate({ data: { profileId: pId, offerId } }, {
      onSuccess: (session) => {
        toast({ title: "Session Launched", description: "Instance provisioning started." });
        queryClient.invalidateQueries({ queryKey: getGetActiveSessionQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        setLocation(`/sessions/${session.id}`);
      },
      onError: () => {
        toast({ title: "Rent Failed", description: "Failed to provision instance.", variant: "destructive" });
      }
    });
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Marketplace</h1>
          <p className="text-muted-foreground mt-1">Browse and rent specific GPU instances from Vast.ai</p>
        </div>
      </div>

      <Card className="bg-card/50 border-border/50">
        <CardContent className="p-4 flex flex-col md:flex-row gap-4 items-end">
          <div className="flex-1 space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">GPU Profile</label>
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger>
                <SelectValue placeholder="Any Profile" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any Profile</SelectItem>
                {profiles?.map(p => (
                  <SelectItem key={p.id} value={p.id.toString()}>{p.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
          <div className="flex-1 space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">GPU Name</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="e.g. RTX 4090" 
                className="pl-9" 
                value={gpuName}
                onChange={(e) => setGpuName(e.target.value)}
              />
            </div>
          </div>

          <div className="flex-1 space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Max Price/Hr</label>
            <div className="relative">
              <DollarSign className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="0.50" 
                type="number"
                step="0.1"
                className="pl-9"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading || isFetching ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))
        ) : offers?.length ? (
          offers.map(offer => (
            <Card key={offer.id} className="bg-card/50 border-border/50 hover:border-primary/30 transition-colors flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle className="text-lg font-bold flex items-center gap-2">
                      {offer.gpuName} <span className="text-sm font-normal text-muted-foreground">x{offer.numGpus}</span>
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                      <Server className="w-3 h-3" /> Machine {offer.id}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold text-primary font-mono">
                      ${offer.dphTotal.toFixed(3)}
                    </div>
                    <div className="text-[10px] text-muted-foreground uppercase">/ hr</div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1 text-sm text-muted-foreground space-y-2">
                <div className="flex justify-between">
                  <span>RAM:</span> <span className="font-mono text-foreground">{offer.totalRam ? Math.round(offer.totalRam/1000) : '?'} GB</span>
                </div>
                <div className="flex justify-between">
                  <span>VRAM:</span> <span className="font-mono text-foreground">{offer.gpuRam} MB</span>
                </div>
                <div className="flex justify-between">
                  <span>CPU:</span> <span className="font-mono text-foreground truncate max-w-[140px]" title={offer.cpuName}>{offer.cpuName}</span>
                </div>
                <div className="flex justify-between">
                  <span>Location:</span> <span className="font-mono text-foreground">{offer.geolocation}</span>
                </div>
              </CardContent>
              <CardFooter className="pt-4 border-t border-border/50">
                <Button 
                  className="w-full" 
                  disabled={createSession.isPending || !offer.rentable}
                  onClick={() => handleRent(offer.id)}
                >
                  {createSession.isPending ? "RENTING..." : "RENT INSTANCE"}
                </Button>
              </CardFooter>
            </Card>
          ))
        ) : (
          <div className="col-span-3 py-12 text-center text-muted-foreground border border-dashed border-border/60 rounded-lg">
            <Filter className="w-8 h-8 mx-auto mb-3 opacity-20" />
            <p>No offers found matching your criteria.</p>
          </div>
        )}
      </div>

    </div>
  );
}
