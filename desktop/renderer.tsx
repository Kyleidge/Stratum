import { createRoot } from 'react-dom/client';
import Workbench from '@/components/workflow-workbench';
import WorkflowErrorBoundary from '@/components/workflow-error-boundary';
import ReportBuilderMockup from '@/components/report-builder-mockup';
import '@/app/globals.css';
import '@/app/regions.css';
import '@/app/workflow.css';
import '@/app/workflow-batch.css';
import '@/app/ui-refresh-mockup.css';
import '@/app/report-builder-mockup.css';
import { smokeTest } from './smoke-test';
import { applyTheme, storedTheme } from '@/lib/theme';

const params = new URL(location.href).searchParams;
// Apply the saved theme before the first render to avoid a flash.
applyTheme(storedTheme());
if (params.has('smoke')) void smokeTest();
// The Reports workspace bundles the report editor, so the preview reuses it.
else if (params.has('report-mockup'))
  createRoot(document.getElementById('root')!).render(<ReportBuilderMockup />);
else if (params.has('mockup'))
  void import('@/components/ui-refresh-mockup').then(
    ({ default: UiRefreshMockup }) =>
      createRoot(document.getElementById('root')!).render(<UiRefreshMockup />),
  );
else {
  createRoot(document.getElementById('root')!).render(
    <WorkflowErrorBoundary>
      <Workbench />
    </WorkflowErrorBoundary>,
  );
  if (params.has('ui-smoke'))
    void import('./workflow-ui-smoke').then(({ workflowUiSmoke }) =>
      workflowUiSmoke(),
    );
}
