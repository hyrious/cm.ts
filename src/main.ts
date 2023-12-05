import './style.css'

import { EditorView, minimalSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { hoverTooltip } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { autocompletion, completeFromList } from '@codemirror/autocomplete'
import { linter } from '@codemirror/lint'
import { reload, sendIPC } from './ipc'

declare const view: EditorView

const readOnly = new Compartment()

fetch('https://data.jsdelivr.com/v1/package/npm/typescript').then(r => r.ok && r.json()).then(data =>
  data ?
    void reload(data.tags.latest).then(() => {
      document.title = 'ts@' + data.tags.latest
      view.dispatch({
        effects: readOnly.reconfigure([
          EditorState.readOnly.of(false),
          EditorView.editable.of(true),
        ]),
      })
    })
  : console.error('Failed to fetch TypeScript versions'))

globalThis.sendIPC = sendIPC

globalThis.view = new EditorView({
  doc: sessionStorage.getItem('doc-cache') || `let a = 1`,
  extensions: [
    minimalSetup,
    readOnly.of([
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ]),
    javascript({ typescript: true }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        sendIPC({ docChanged: update.state.doc.toString() }).catch(() => [])
        sessionStorage.setItem('doc-cache', update.state.doc.toString())
      }
    }),
    autocompletion({
      override: [
        async (ctx) => {
          const res = await sendIPC({ autocomplete: ctx.pos }).catch(() => [])
          if (!('autocomplete' in res) || !res.autocomplete) return null
          return completeFromList(res.autocomplete)(ctx)
        }
      ]
    }),
    linter(async () => {
      const res = await sendIPC({ lint: true }).catch(() => [])
      if (!('lint' in res) || !res.lint) return []
      return res.lint
    }),
    hoverTooltip(async (_, pos) => {
      const res = await sendIPC({ hover: pos }).catch(() => [])
      if (!('hover' in res) || !res.hover) return null
      return {
        pos,
        create() {
          const dom = document.createElement('div')
          dom.classList.add('cm-quickinfo-tooltip')
          dom.textContent = res.hover
          return { dom }
        }
      }
    }),
  ],
  parent: document.getElementById('editor')!
})
