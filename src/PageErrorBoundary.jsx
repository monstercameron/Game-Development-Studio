import React from 'react';

/** Keep a failed workspace from taking the navigation and the rest of Forge down. */
export default class PageErrorBoundary extends React.Component {
  state = { error: null, copyStatus: '' };

  static getDerivedStateFromError(error) {
    // JavaScript allows throwing null, undefined, and primitive values. Normalize them so
    // `null` remains an unambiguous sentinel for the healthy state.
    if (error instanceof Error) {
      return { error };
    }
    let detail = 'A non-Error value was thrown.';
    try {
      if (error !== null && error !== undefined) {
        detail = String(error);
      }
    } catch {
      // A thrown object's custom string conversion can itself fail.
    }
    return { error: new Error(detail) };
  }

  async copyError() {
    const detail = this.state.error?.stack || this.state.error?.message || String(this.state.error);
    try {
      await navigator.clipboard.writeText(detail);
      this.setState({ copyStatus: 'Error copied.' });
    } catch {
      this.setState({ copyStatus: 'Select the details below to copy them.' });
    }
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    const detail = this.state.error?.stack || this.state.error?.message || String(this.state.error);
    const chunkFailed =
      /dynamically imported module|loading (?:css |chunk)|failed to fetch dynamically/i.test(
        detail,
      );
    return (
      <section className="page page-error" role="alert">
        <h1>Could not open {this.props.name || 'this workspace'}</h1>
        <p className="lead">
          The rest of the studio is still available. Copy these details if you need help fixing the
          problem.
        </p>
        <pre className="game-result">{detail}</pre>
        <div className="page-error-actions">
          <button className="outline-button" type="button" onClick={() => this.copyError()}>
            Copy error
          </button>
          {chunkFailed ? (
            <button
              className="outline-button"
              type="button"
              onClick={() => window.location.reload()}
            >
              Reload studio
            </button>
          ) : (
            <button
              className="outline-button"
              type="button"
              onClick={() => this.setState({ error: null, copyStatus: '' })}
            >
              Try again
            </button>
          )}
        </div>
        {this.state.copyStatus && <p role="status">{this.state.copyStatus}</p>}
      </section>
    );
  }
}
