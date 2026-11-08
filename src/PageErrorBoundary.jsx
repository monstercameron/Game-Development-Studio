import React from 'react';
import { createLog } from './app-log.js';

const log = createLog('errors');

/** Keep a failed workspace from taking the navigation and the rest of Forge down. */
export default class PageErrorBoundary extends React.Component {
  state = { error: null, copyStatus: '' };
  headingRef = React.createRef();

  componentDidCatch(error, info) {
    this.headingRef.current?.focus();
    // The Errors review listens for this event (src/error-capture.js). An event keeps this
    // boundary free of imports, so it still works if error capture fails to load.
    log.error('errors.boundary.caught', { errorClass: error?.name });
    try {
      window.dispatchEvent(
        new window.CustomEvent('forge:caught-error', {
          detail: { error, componentStack: info?.componentStack || '', name: this.props.name },
        }),
      );
    } catch (dispatchError) {
      // Reporting is optional; the fallback below is what keeps the studio usable.
      log.warn('errors.boundary.dispatch.failed', { errorClass: dispatchError?.name });
    }
  }

  componentDidUpdate(_previousProps, previousState) {
    if (this.state.error && this.state.error !== previousState.error) {
      this.headingRef.current?.focus();
    }
  }

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
      // log-coverage: ignore -- static render-phase method; logging during rendering is not allowed
    } catch {
      // A thrown object's custom string conversion can itself fail.
    }
    return { error: new Error(detail) };
  }

  getErrorDetails() {
    try {
      return this.state.error?.stack || this.state.error?.message || 'Unknown page error.';
      // log-coverage: ignore -- called from render(); logging during rendering is not allowed
    } catch {
      return 'Error details could not be read.';
    }
  }

  async copyError() {
    const detail = this.getErrorDetails();
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard access is unavailable.');
      }
      await navigator.clipboard.writeText(detail);
      log.info('errors.copy.succeeded', { kind: 'boundary' });
      this.setState({ copyStatus: 'Error details copied.' });
    } catch (error) {
      log.warn('errors.copy.failed', { kind: 'boundary', errorClass: error?.name });
      this.setState({ copyStatus: 'Copy is unavailable. Select the details below.' });
    }
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    const detail = this.getErrorDetails();
    const chunkFailed =
      /dynamically imported module|loading (?:css |chunk)|failed to fetch dynamically/i.test(
        detail,
      );
    return (
      <section className="page page-error" role="alert">
        <h1 ref={this.headingRef} tabIndex={-1}>
          Could not open {this.props.name || 'this workspace'}
        </h1>
        <p className="lead">
          The rest of the studio is still available. Copy the error details to help diagnose this
          page.
        </p>
        <pre className="game-result" tabIndex={0} aria-label="Error details">
          {detail}
        </pre>
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
        <p className="page-error-status" role="status" aria-live="polite" aria-atomic="true">
          {this.state.copyStatus}
        </p>
      </section>
    );
  }
}
