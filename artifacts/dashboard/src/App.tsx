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
        <Route path="/skills" component={SkillsLibrary} />
        <Route path="/memory" component={Memory} />
        <Route path="/design-intelligence" component={DesignIntelligence} />
        <Route path="/ambient" component={AmbientPage} />
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
          <div className="dark bg-background text-foreground min-h-screen">
            <Router />
          </div>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
