import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { getLocalHHMM } from "@/lib/time-utils";
import type { SchedulerConfig, Session } from "@workspace/api-client-react";

interface StopCountdownModalProps {
  schedulerConfig?: SchedulerConfig | null;
  activeSession?: Session | null;
  onStop: () => void;
}

export function StopCountdownModal({ schedulerConfig, activeSession, onStop }: StopCountdownModalProps) {
  const [showModal, setShowModal] = useState(false);
  const [countdown, setCountdown] = useState(10);
  const suppressedRef = useRef(false);
  const stopTriggeredRef = useRef(false);

  const isActive = activeSession &&
    activeSession.status !== "stopped" &&
    activeSession.status !== "error";

  // Monitor for stop time
  useEffect(() => {
    if (!schedulerConfig?.enabled || !isActive || suppressedRef.current) return;

    const checkInterval = setInterval(() => {
      const localTime = getLocalHHMM(schedulerConfig.timezone);
      if (localTime === schedulerConfig.stopTime && !showModal && !suppressedRef.current) {
        setShowModal(true);
        setCountdown(10);
        stopTriggeredRef.current = false;
      }
    }, 1000);

    return () => clearInterval(checkInterval);
  }, [schedulerConfig, isActive, showModal]);

  // Countdown timer
  useEffect(() => {
    if (!showModal) return;

    const countdownInterval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1 && !stopTriggeredRef.current) {
          stopTriggeredRef.current = true;
          setShowModal(false);
          onStop();
          return 0;
        }
        return c - 1;
      });
    }, 1000);

    return () => clearInterval(countdownInterval);
  }, [showModal, onStop]);

  const handleKeepRunning = () => {
    setShowModal(false);
    suppressedRef.current = true;
    // Reset suppression after 1 hour so user gets reminded again if they forgot
    setTimeout(() => { suppressedRef.current = false; }, 60 * 60 * 1000);
  };

  if (!showModal) return null;

  return (
    <Dialog open>
      <DialogContent className="sm:max-w-md border-destructive/50 bg-destructive/5">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-full bg-destructive/20 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-destructive" />
            </div>
            <DialogTitle>Scheduled Session Stop</DialogTitle>
          </div>
          <DialogDescription>
            Your scheduled stop time (<strong>{schedulerConfig?.stopTime}</strong>) has been reached.
            The session will be destroyed automatically in{" "}
            <strong className="text-destructive text-lg tabular-nums">{countdown}</strong> seconds.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-center py-4">
          <div
            className="relative w-20 h-20 flex items-center justify-center"
            style={{
              background: `conic-gradient(hsl(var(--destructive)) ${(countdown / 10) * 360}deg, hsl(var(--border)) 0deg)`,
              borderRadius: "50%",
            }}
          >
            <div className="absolute inset-1.5 rounded-full bg-background flex items-center justify-center">
              <span className="text-3xl font-bold tabular-nums text-destructive">{countdown}</span>
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={handleKeepRunning} className="flex-1">
            Keep Running
          </Button>
          <Button variant="destructive" onClick={() => { stopTriggeredRef.current = true; setShowModal(false); onStop(); }} className="flex-1">
            Stop Now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
