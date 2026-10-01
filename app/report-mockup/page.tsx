import type { Metadata } from 'next';
import ReportBuilderMockup from '@/components/report-builder-mockup';

export const metadata: Metadata = {
  title: 'Stratum · Report builder mockup',
  description: 'A local canvas for composing signal analysis reports.',
};

export default function Page() {
  return <ReportBuilderMockup />;
}
