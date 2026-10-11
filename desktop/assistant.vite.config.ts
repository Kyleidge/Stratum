import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Bundles the AI assistant server (mcp/app-server.ts) into one Node module,
 * dist-desktop/assistant-server.mjs, which Stratum runs as Node for MCP
 * clients. Runs after the renderer build, which empties dist-desktop.
 */
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // The version MCP clients see; not an argument, so copied entries stay
  // valid across updates.
  define: { __STRATUM_VERSION__: JSON.stringify(manifest.version) },
  // Bundle everything: the packaged app has no node_modules for it.
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: fileURLToPath(new URL('../mcp/app-server.ts', import.meta.url)),
    outDir: '../dist-desktop',
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    rolldownOptions: { output: { entryFileNames: 'assistant-server.mjs' } },
  },
});
