import type { Completion } from '@codemirror/autocomplete'
import type { Diagnostic } from '@codemirror/lint'
import type { IPCRequest, IPCResponse } from './ipc'
import * as tvfs from '@typescript/vfs'
import { setupTypeAcquisition } from './ata'

declare const ts: typeof import('typescript')

interface API {
  updateFile(text: string): void
  getCompletionsAtPosition(position: number): import('typescript').CompletionInfo | undefined
  getQuickInfoAtPosition(position: number): import('typescript').QuickInfo | undefined
  getDiagnostics(): import('typescript').Diagnostic[]
}

const setup = async (version: string): Promise<API> => {
  const options: import('typescript').CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    lib: ["esnext", "dom"],
    esModuleInterop: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  }

  const indexTs = '/index.ts'
  const fsMap = await tvfs.createDefaultMapFromCDN(options, ts.version, false, ts)
  fsMap.set(indexTs, `let a = 1`)

  const system = tvfs.createSystem(fsMap)
  const env = tvfs.createVirtualTypeScriptEnvironment(system, [indexTs], ts, options)

  console.log('typescript @', version)
  const ata = setupTypeAcquisition(ts, {
    receivedFile(code, path) {
      env.createFile(path, code)
    }
  })

  let timer = 0
  function updateFile(text: string) {
    env.updateFile(indexTs, text || ' ')
    clearTimeout(timer)
    timer = setTimeout(() => ata(text), 500)
  }

  function getCompletionsAtPosition(position: number) {
    return env.languageService.getCompletionsAtPosition(indexTs, position, void 0)
  }

  function getQuickInfoAtPosition(position: number) {
    return env.languageService.getQuickInfoAtPosition(indexTs, position)
  }

  function getDiagnostics() {
    const syntactic = env.languageService.getSyntacticDiagnostics(indexTs)
    const semantic = env.languageService.getSemanticDiagnostics(indexTs)
    const suggestion = env.languageService.getSuggestionDiagnostics(indexTs)
    return [...syntactic, ...semantic, ...suggestion]
  }

  return { updateFile, getCompletionsAtPosition, getQuickInfoAtPosition, getDiagnostics }
}

const handler = function (this: API, e: MessageEvent<IPCRequest>) {
  // https://github.com/microsoft/TypeScript/blob/main/src/services/completions.ts#L404
  const sortTextToBoost = (sortText: string): number =>
    sortText.startsWith('z') ? -99 : parseInt(sortText)

  const respond: (response: IPCResponse) => void = postMessage
  const message = e.data

  if ('docChanged' in message) {
    this.updateFile(message.docChanged)
    respond({ docChanged: true })
  }

  if ('autocomplete' in message) {
    const completionInfo = this.getCompletionsAtPosition(message.autocomplete)
    const completions: Completion[] | undefined = completionInfo?.entries.map((c, i) => ({
      type: c.kind.replace('var', 'variable'),
      label: c.name,
      boost: sortTextToBoost(c.sortText)
    }))
    respond({ autocomplete: completions })
  }

  if ('lint' in message) {
    const diagnosticsInfo = this.getDiagnostics().filter(d => d.start != null)
    const diagnostics: Diagnostic[] = diagnosticsInfo.map((d, i) => ({
      from: d.start!,
      to: d.length != null ? d.start! + d.length : d.start! + 1,
      message: d.messageText + '',
      source: d.source,
      severity: ["warning", "error", "info", "info"][d.category] as Diagnostic["severity"]
    }))
    respond({ lint: diagnostics })
  }

  if ('hover' in message) {
    const info = this.getQuickInfoAtPosition(message.hover)
    const text = ts.displayPartsToString(info.displayParts) + (info.documentation?.length ? '\n' + ts.displayPartsToString(info.documentation) : '')
    respond({ hover: text })
  }
}

onmessage = async (e: MessageEvent<string>) => {
  try {
    const api = await setup(e.data)
    onmessage = handler.bind(api)
    postMessage({ status: 'success' })
  } catch (err) {
    console.error(err)
    postMessage({ status: 'failure', error: err + '' })
  }
}
