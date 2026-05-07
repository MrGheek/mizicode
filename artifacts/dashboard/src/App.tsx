import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/layout/app-layout";
import Dashboard from "@/pages/dashboard";
import Sessions from "@/pages/sessions/index";
import SessionDetail from "@/pages/sessions/[id]";
import Templates from "@/pages/templates/index";
import Memory from "@/pages/memory";
import SkillsLibrary from "@/pages/skills/index";
import DesignIntelligence from "@/pages/design-intelligence";
import AmbientPage from "@/pages/ambient";
import SettingsPage from "@/pages/settings";
import ApiKeysPage from "@/pages/api-keys";
import IntelligencePage from "@/pages/intelligence";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/sessions" component={Sessions} />
        <Route path="/sessions/:id" component={SessionDetail} />
        <Route path="/templates" component={Templates} />
        <Route path="/intelligence" component={IntelligencePage} />
        <Route path="/intelligence/memory" component={Memory} />
        <Route path="/intelligence/skills" component={SkillsLibrary} />
        <Route path="/skills" component={SkillsLibrary} />
        <Route path="/memory" component={Memory} />
        <Route path="/design-intelligence" component={DesignIntelligence} />
        <Route path="/ambient" component={AmbientPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/api-keys" component={ApiKeysPage} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <div className="min-h-screen" style={{ background: "var(--bg-base)", color: "var(--text-primary)" }}>
            <Router />
          </div>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
