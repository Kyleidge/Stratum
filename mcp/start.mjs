// Starts the Stratum MCP server over stdio: `node mcp/start.mjs`.
// stdout carries protocol messages only, so console output goes to stderr.
// TypeScript sources load through the test loader (in-memory transpilation)
// and IndexedDB is fake-indexeddb, as in `pnpm test`.
for (const method of ['log', 'info', 'debug', 'warn'])
  console[method] = (...args) => console.error(...args);
await import('../tests/typescript-loader.mjs');
await import('fake-indexeddb/auto');
const { main } = await import('./server.ts');
await main();
