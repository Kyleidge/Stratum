// The running Stratum version, from package.json at build time. Vite, the
// desktop build and the Node tests all read JSON modules this way.
import manifest from '../package.json' with { type: 'json' };

export const APP_VERSION: string = manifest.version;
