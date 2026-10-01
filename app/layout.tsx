import type { Metadata } from 'next';
import './globals.css';
import './regions.css';
import './workflow.css';
import './ui-refresh-mockup.css';
import './report-builder-mockup.css';

export const metadata: Metadata = {
  title: 'Stratum · Signal Workbench',
  description: 'Immutable signals. Traceable engineering analysis.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" data-theme="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
