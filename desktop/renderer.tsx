import { createRoot } from 'react-dom/client';
import Workbench from '@/components/workflow-workbench';
import WorkflowErrorBoundary from '@/components/workflow-error-boundary';
import '@/app/globals.css';
import '@/app/regions.css';
import '@/app/workflow.css';
import { smokeTest } from './smoke-test';

if (new URL(location.href).searchParams.has('smoke')) void smokeTest();
else {
  createRoot(document.getElementById('root')!).render(
    <WorkflowErrorBoundary>
      <Workbench />
    </WorkflowErrorBoundary>,
  );
  if (new URL(location.href).searchParams.has('ui-smoke'))
    void import('./workflow-ui-smoke').then(({ workflowUiSmoke }) =>
      workflowUiSmoke(),
    );
}
