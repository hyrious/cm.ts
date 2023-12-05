import { defineConfig, Plugin, ResolvedConfig } from 'vite'
import { context, BuildContext } from 'esbuild'

export default defineConfig({
  base: '',
  plugins: [emitWorker()],
})

function emitWorker(): Plugin {
  let config: ResolvedConfig
  let ctx: BuildContext
  return {
    name: 'emit-worker',
    enforce: 'pre',
    configResolved(config_) {
      config = config_
    },
    async buildStart() {
      ctx = await context({
        entryPoints: ['src/worker.ts'],
        bundle: true,
        format: 'esm',
        outdir: 'public',
        minify: config.command === "build",
        define: { require: 'noop' },
        inject: ['src/worker.inject.ts']
      })
      await ctx.rebuild()
      if (config.command === "serve") {
        await ctx.watch()
      }
    },
    load(id) {
      if (id.endsWith('ipc.ts')) {
        this.addWatchFile('./worker.ts')
        this.addWatchFile('./ata.ts')
      }
    },
    async buildEnd() {
      await ctx.dispose()
    }
  }
}
