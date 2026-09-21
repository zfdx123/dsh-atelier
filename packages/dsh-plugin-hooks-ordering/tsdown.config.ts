import { defineConfig } from 'tsdown'

// Emit ESM plus type declarations for the public entry points. cordis is a
// peer dependency and schemastery backs the dsh settings schema; both stay
// external so the consumer's copies are the ones loaded — bundling schemastery
// would ship a second copy of it inside this package.
//
// Only entries with an `exports` subpath belong here. `src/service-base.ts` is
// listed because the shared base (and `HookControlError`) must be emitted once
// and imported by both `waterfall` and `serial`, keeping a single class identity
// across entry points. `dsh.ts` and `settings.ts` are deliberately NOT entries:
// they are reached through the root barrel, so rolldown emits them as shared
// chunks instead of lib files nothing can import.
export default defineConfig({
  entry: ['src/index.ts', 'src/topo-sort.ts', 'src/dag.ts', 'src/service-base.ts', 'src/waterfall.ts', 'src/serial.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'lib',
  external: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'],
})
