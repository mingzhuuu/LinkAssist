import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Label shown in the error UI to identify which boundary caught the error */
  label?: string;
  /** Minimal mode: show inline error instead of full-screen overlay */
  inline?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`, error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const { label, inline } = this.props;
      const errorMessage = this.state.error.message || 'Unknown error';
      const errorStack = this.state.error.stack || '';

      if (inline) {
        return (
          <div className="flex flex-col items-center justify-center h-full p-4 bg-surface text-text-primary">
            <p className="text-xs font-semibold text-accent-red mb-1">
              {label ? `${label}: Render Error` : 'Render Error'}
            </p>
            <p className="text-xs text-text-muted mb-3 max-w-md text-center break-words">{errorMessage}</p>
            <button
              className="px-3 py-1.5 text-xs bg-surface-tertiary border border-border rounded-lg text-text-primary hover:bg-surface-overlay transition-colors"
              onClick={this.handleReset}
            >
              Retry
            </button>
          </div>
        );
      }

      return (
        <div className="w-full h-full flex items-center justify-center bg-surface p-8">
          <div className="max-w-lg w-full bg-surface-overlay border border-border rounded-2xl p-6 shadow-2xl">
            <h2 className="text-sm font-semibold text-accent-red mb-2">
              {label ? `${label}: Application Error` : 'Application Error'}
            </h2>
            <p className="text-xs text-text-secondary mb-4 break-words">{errorMessage}</p>
            {errorStack && (
              <pre className="text-[10px] text-text-muted bg-surface-tertiary border border-border rounded-lg p-3 mb-4 overflow-auto max-h-40 whitespace-pre-wrap break-words">
                {errorStack}
              </pre>
            )}
            <button
              className="px-4 py-2 text-xs font-medium bg-accent-mauve text-text-primary rounded-lg hover:opacity-90 transition-opacity"
              onClick={this.handleReset}
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
