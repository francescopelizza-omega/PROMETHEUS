/**
 * shell/ErrorBoundary.tsx — a React error boundary so a render-time throw in ONE
 * route (an undefined deref, a bad API shape) shows a recoverable fallback instead
 * of white-screening the whole app. Wraps <App/> (root) AND each route (per-activity)
 * so a crash is contained to its panel and the shell/rail/palette keep working.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** shown in the fallback + the console log (e.g. the activity id). */
  label?: string;
  /** a remount key — when it changes, the boundary auto-resets (e.g. on navigation). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props): void {
    // a navigation (resetKey change) clears a prior crash so the new view renders.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // forwarded to the terminal via electron-vite's renderer console bridge.
    // eslint-disable-next-line no-console
    console.error(
      `[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ""}]`,
      error,
      info.componentStack,
    );
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          margin: "var(--space-8, 16px)",
          padding: "var(--space-8, 16px)",
          borderRadius: "var(--radius-lg, 8px)",
          border: "1px solid var(--danger)",
          background: "var(--bg-surface)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-ui)",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: "6px" }}>
          ⚠ Something went wrong{this.props.label ? ` in ${this.props.label}` : ""}
        </div>
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: "0.85rem",
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            marginBottom: "12px",
          }}
        >
          {error.message || String(error)}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            type="button"
            onClick={this.reset}
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-md, 6px)",
              border: "1px solid var(--border-subtle)",
              background: "var(--bg-surface-2)",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "6px 12px",
              borderRadius: "var(--radius-md, 6px)",
              border: "1px solid var(--border-subtle)",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
