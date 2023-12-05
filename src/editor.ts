import { EditorView, basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'

export const view = new EditorView({
  doc: `let a = 1`,
  extensions: [basicSetup, javascript({ typescript: true })],
  parent: document.getElementById('editor')!
})
