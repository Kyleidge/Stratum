import Workbench from '@/components/workflow-workbench';
import WorkflowErrorBoundary from '@/components/workflow-error-boundary';

export default function Page() {
  return (
    <WorkflowErrorBoundary>
      <Workbench />
    </WorkflowErrorBoundary>
  );
}
