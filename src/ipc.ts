import type { Completion } from '@codemirror/autocomplete'
import type { Diagnostic } from '@codemirror/lint'

export type IPCRequest =
  | { docChanged: string }
  | { autocomplete: number }
  | { lint: true }
  | { hover: number }

export type IPCResponse =
  | { docChanged: boolean }
  | { autocomplete: Completion[] | undefined }
  | { lint: Diagnostic[] }
  | { hover: string }

interface Task {
  message: any
  resolve: (value: any) => void
  abort: () => void
}

let workerText: Promise<string> | null = null
let activeTask: Task | null = null
let pendingTask: Task | null = null

let onReload: (version: string) => Promise<Worker> = () => null as any
export const reload = (version: string) => onReload(version)

let workerPromise = new Promise<Worker>((resolve, reject) => {
  onReload = (version) => {
    const reloadPromise = reloadWorker(version)
    reloadPromise.then(resolve, reject)
    onReload = (version) => {
      workerPromise.then((worker) => worker.terminate())
      workerPromise = reloadWorker(version)
      return workerPromise
    }
    return reloadPromise
  }
})

async function packageFetch(subpath: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('Timeout'), timeoutMs)
  try {
    const response = await fetch(`https://cdn.jsdelivr.net/npm/${subpath}`, { signal: controller.signal })
    if (response.ok) {
      clearTimeout(timeout)
      return response
    }
  } catch (err) {
    console.error(err)
  }
  return fetch(`https://unpkg.com/${subpath}`, { signal: controller.signal })
}

async function reloadWorker(version: string): Promise<Worker> {
  let loadingFailure: string | undefined

  try {
    if (activeTask) activeTask.abort()
    if (pendingTask) pendingTask.abort()
    activeTask = pendingTask = null

    const [workerJS, typescriptJS] = await Promise.all([
      (workerText ||= fetch('worker.js').then(r => r.text())),
      packageFetch(`typescript@${version}/lib/typescript.js`).then(r => r.text()),
    ])
    setupLocal(typescriptJS)

    const i = workerJS.lastIndexOf('//# sourceMappingURL=')
    const workerJsWithoutSourceMap = i >= 0 ? workerJS.slice(0, i) : workerJS
    const parts = [typescriptJS, workerJsWithoutSourceMap]
    const url = URL.createObjectURL(new Blob(parts, { type: 'application/javascript' }))

    return new Promise((resolve, reject) => {
      const worker = new Worker(url)
      worker.onmessage = (e) => {
        worker.onmessage = null
        if (e.data.status === 'success') {
          resolve(worker)
        } else {
          reject(new Error('Failed to create worker'))
          loadingFailure = e.data.error
        }
        URL.revokeObjectURL(url)
      }
      worker.postMessage(version)
    })
  } catch (err) {
    console.error(loadingFailure || err + '')
    throw err
  }
}

let script: HTMLScriptElement | null = null
function setupLocal(js: string) {
  const url = URL.createObjectURL(new Blob([js], { type: 'application/javascript' }))
  if (script) { URL.revokeObjectURL(script.src); script.remove() }
  script = document.createElement('script')
  script.src = url
  document.head.appendChild(script)
}

export function sendIPC(message: IPCRequest): Promise<IPCResponse> {
  function activateTask(worker: Worker, task: Task) {
    if (activeTask) {
      if (pendingTask) pendingTask.abort()
      pendingTask = task
    } else {
      activeTask = task
      worker.onmessage = (e) => {
        worker.onmessage = null
        task.resolve(e.data)
        activeTask = null
        if (pendingTask) {
          activateTask(worker, pendingTask)
          pendingTask = null
        }
      }
      worker.postMessage(task.message)
    }
  }

  return new Promise((resolve, reject) => workerPromise.then(
    worker => activateTask(worker, {
      message,
      resolve,
      abort: () => reject(new Error('Task aborted')),
    }),
    reject,
  ))
}
