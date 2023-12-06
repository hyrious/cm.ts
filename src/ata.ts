// Credit: https://github.com/microsoft/TypeScript-Website/blob/v2/packages/ata/src/index.ts
const builtinModules = new Set([
  "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "events",
  "fs", "fs/promises", "http", "http2", "https", "inspector", "module", "net", "os", "path",
  "path/posix", "path/win32", "perf_hooks", "process", "punycode", "querystring", "readline",
  "repl", "stream", "stream/promises", "stream/consumers", "stream/web", "string_decoder", "sys",
  "timers", "timers/promises", "tls", "trace_events", "tty", "url", "util", "util/types", "v8",
  "vm", "wasi", "worker_threads", "zlib",
])

export interface Callbacks {
  receivedFile(code: string, path: string): void
}

export function setupTypeAcquisition(ts: typeof import("typescript"), delegate: Callbacks) {
  const moduleMap = new Set<string>()
  const fsMap = new Map<string, string>()

  return (code: string) => resolveDeps(code, 0)

  async function resolveDeps(code: string, depth: number) {
    const meta = ts.preProcessFile(code)
    // @ts-ignore
    const libMap = ts.libMap || new Map()

    const deptsToGet = meta.referencedFiles
      .concat(meta.importedFiles)
      .concat(meta.libReferenceDirectives)
      .filter(f => !f.fileName.endsWith('.d.ts'))
      .filter(d => !libMap.has(d.fileName))
      .map(r => {
        let module = r.fileName
        if (builtinModules.has(module.replace('node:', ''))) module = 'node'
        else {
          const [a = '', b = ''] = module.split('/')
          module = a[0] === '@' ? `${a}/${b}` : a
        }
        return { module, version: 'latest' }
      })
      .filter(f => !f.module.startsWith('.'))
      .filter(m => !moduleMap.has(m.module))

    deptsToGet.forEach(dep => moduleMap.add(dep.module))

    const trees = (await Promise.all(deptsToGet.map(f => getFileTreeForModuleWithTag(f.module, f.version))))
      .filter(t => !("error" in t)) as NPMTreeMeta[]

    const hasDTS = trees.filter(t => t.files.find(f => f.name.endsWith('.d.ts')))
    const dtsFilesFromNPM = hasDTS.map(t => treeToDTSFiles(t, `/node_modules/${t.moduleName}`))

    const dtTrees = (await Promise.all(trees.filter(t => !hasDTS.includes(t)).map(f => getFileTreeForModuleWithTag(`@types/${getDTName(f.moduleName)}`, 'latest'))))
      .filter(t => !("error" in t)) as NPMTreeMeta[]
    const dtsFilesFromDT = dtTrees.map(t => treeToDTSFiles(t, `/node_modules/@types/${getDTName(t.moduleName).replace("types__", "")}`))

    const allDTSFiles = dtsFilesFromNPM.concat(dtsFilesFromDT).reduce((p, c) => p.concat(c), [])
    for (const tree of trees) {
      let prefix = `/node_modules/${tree.moduleName}`
      if (dtTrees.includes(tree)) prefix = `/node_modules/@types/${getDTName(tree.moduleName).replace("types__", "")}`
      const path = prefix + "/package.json"
      const pkgJSON = await getDTSFileForModuleWithVersion(tree.moduleName, tree.version, "/package.json")

      if (typeof pkgJSON == "string") {
        fsMap.set(path, pkgJSON)
        delegate.receivedFile(pkgJSON, path)
      }
    }

    await Promise.all(
      allDTSFiles.map(async dts => {
        const dtsCode = await getDTSFileForModuleWithVersion(dts.moduleName, dts.moduleVersion, dts.path)
        if (dtsCode) {
          fsMap.set(dts.vfsPath, dtsCode)
          delegate.receivedFile(dtsCode, dts.vfsPath)
          await resolveDeps(dtsCode, depth + 1)
        }
      })
    )
  }
}

async function getFileTreeForModuleWithTag(moduleName: string, tag?: string) {
  let toDownload = tag || "latest"

  if (toDownload.split(".").length < 2) {
    const response = await npm_resolve(moduleName, toDownload)
    if (response instanceof Error) {
      return {
        error: response,
        userFacingMessage: `Could not go from a tag to version on npm for ${moduleName} - possible typo?`,
      }
    }

    const neededVersion = response.version
    if (!neededVersion) {
      const versions = await npm_versions(moduleName)
      if (versions instanceof Error) {
        return {
          error: response,
          userFacingMessage: `Could not get versions on npm for ${moduleName} - possible typo?`,
        }
      }

      const tags = Object.entries(versions.tags).join(", ")
      return {
        error: new Error("Could not find tag for module"),
        userFacingMessage: `Could not find a tag for ${moduleName} called ${tag}. Did find ${tags}`,
      }
    }

    toDownload = neededVersion
  }

  const res = await getFiletreeForModuleWithVersion(moduleName, toDownload)
  if (res instanceof Error) {
    return {
      error: res,
      userFacingMessage: `Could not get the files for ${moduleName}@${toDownload}. Is it possibly a typo?`,
    }
  }

  return res
}


type ATADownload = {
  moduleName: string
  moduleVersion: string
  vfsPath: string
  path: string
}

function treeToDTSFiles(tree: NPMTreeMeta, vfsPrefix: string) {
  const dtsRefs: ATADownload[] = []

  for (const file of tree.files) {
    if (file.name.endsWith(".d.ts")) {
      dtsRefs.push({
        moduleName: tree.moduleName,
        moduleVersion: tree.version,
        vfsPath: `${vfsPrefix}${file.name}`,
        path: file.name,
      })
    }
  }
  return dtsRefs
}

async function npm_versions(name: string): Promise<{ tags: Record<string, string>, versions: string[] }> {
  return await fetch(`https://data.jsdelivr.com/v1/package/npm/${name}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : new Error("OK"))
}

async function npm_resolve(name: string, spec: string): Promise<{ version: string | null }> {
  return await fetch(`https://data.jsdelivr.com/v1/package/resolve/npm/${name}@${spec}`).then(r => r.ok ? r.json() : new Error("OK"))
}

interface NPMTreeMeta {
  default: string
  files: { name: string }[]
  moduleName: string
  version: string
}

async function getFiletreeForModuleWithVersion(moduleName: string, version: string): Promise<NPMTreeMeta> {
  return await fetch(`https://data.jsdelivr.com/v1/package/npm/${moduleName}@${version}/flat`).then(r => r.ok ? r.json() : new Error("OK")).then(e => ({ ...e, moduleName, version }))
}

async function getDTSFileForModuleWithVersion(moduleName: string, version: string, file: string): Promise<string> {
  return await fetch(`https://cdn.jsdelivr.net/npm/${moduleName}@${version}${file}`).then(r => r.ok ? r.text() : '')
}

// Taken from dts-gen: https://github.com/microsoft/dts-gen/blob/master/lib/names.ts
function getDTName(s: string) {
  if (s.indexOf("@") === 0 && s.indexOf("/") !== -1) {
    s = s.slice(1).replace("/", "__")
  }
  return s
}
