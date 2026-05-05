import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// Wire the generated API client to use the correct API origin.
// On Replit, VITE_API_BASE_URL is unset so setBaseUrl receives null and the
// client falls back to same-origin relative paths (no change from before).
// On Fly.io, VITE_API_BASE_URL is baked in at build time and the generated
// client will prepend the API server's hostname to every request.
const rawApiBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
setBaseUrl(rawApiBase ?? null);

createRoot(document.getElementById("root")!).render(<App />);
