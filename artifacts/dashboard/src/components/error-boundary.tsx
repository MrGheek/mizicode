import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RootErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[MIZI] Uncaught render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a14",
          color: "#e2e8f0",
          fontFamily: "monospace",
          padding: "2rem",
        }}
      >
        <div style={{ maxWidth: "640px", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
            <div
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "10px",
                background: "linear-gradient(135deg, #00b4d8, #7c3aed)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                fontWeight: 700,
                fontSize: "14px",
                flexShrink: 0,
              }}
            >
              M
            </div>
            <span style={{ fontWeight: 600, fontSize: "16px", letterSpacing: "-0.01em" }}>
              MIZI Code — startup error
            </span>
          </div>

          <div
            style={{
              background: "rgba(244,63,94,0.08)",
              border: "1px solid rgba(244,63,94,0.25)",
              borderRadius: "10px",
              padding: "16px 20px",
              marginBottom: "20px",
            }}
          >
            <p style={{ color: "#f43f5e", fontWeight: 600, fontSize: "13px", marginBottom: "8px" }}>
              {error.name}: {error.message}
            </p>
            {error.stack && (
              <pre
                style={{
                  fontSize: "11px",
                  color: "rgba(226,232,240,0.5)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                  maxHeight: "240px",
                  overflow: "auto",
                }}
              >
                {error.stack}
              </pre>
            )}
          </div>

          <p style={{ fontSize: "12px", color: "rgba(226,232,240,0.45)", lineHeight: 1.6, marginBottom: "16px" }}>
            A critical error occurred before the UI could finish loading. Check the browser console for
            more detail, or try a hard-refresh (<kbd>Ctrl+Shift+R</kbd> / <kbd>Cmd+Shift+R</kbd>).
          </p>

          <button
            onClick={() => window.location.reload()}
            style={{
              background: "rgba(0,180,216,0.12)",
              border: "1px solid rgba(0,180,216,0.3)",
              color: "#00b4d8",
              borderRadius: "8px",
              padding: "8px 20px",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "monospace",
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
