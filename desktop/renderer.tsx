import { createRoot } from 'react-dom/client';
import Workbench from '@/components/region-workbench';
import '@/app/globals.css';
import '@/app/regions.css';
import { smokeTest } from './smoke-test';

if (new URL(location.href).searchParams.has('smoke')) void smokeTest();
else createRoot(document.getElementById('root')!).render(<Workbench />);
