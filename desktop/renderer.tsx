import { createRoot } from 'react-dom/client';
import Workbench from '@/components/workflow-workbench';
import WorkflowErrorBoundary from '@/components/workflow-error-boundary';
import '@/app/globals.css';
import '@/app/regions.css';
import '@/app/workflow.css';
import '@/app/ui-refresh-mockup.css';
import { smokeTest } from './smoke-test';

const params = new URL(location.href).searchParams;
if (params.has('smoke')) void smokeTest();
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
