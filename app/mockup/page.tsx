import type { Metadata } from 'next';
import UiRefreshMockup from '@/components/ui-refresh-mockup';

export const metadata: Metadata = {
  title: 'Stratum · UI refresh mockup',
  description: 'Static preview of the proposed workbench layout.',
};

export default function Page() {
  return <UiRefreshMockup />;
}
