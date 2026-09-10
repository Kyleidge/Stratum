'use client';
import { Component, type ReactNode } from 'react';

export default class WorkflowErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="workflow-empty-workspace">
          <h1>The workspace could not be displayed</h1>
          <p>
            Your saved data has not been cleared. Reload to reopen the last
            committed workspace.
          </p>
          <button className="primary-button" onClick={() => location.reload()}>
            Reload workspace
          </button>
        </main>
      );
    return this.props.children;
  }
}
