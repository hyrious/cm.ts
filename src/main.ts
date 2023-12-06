import './style.css'

import * as Y from 'yjs'
import * as random from 'lib0/random'
import { yCollab } from 'y-codemirror.next'
import { IndexeddbPersistence } from 'y-indexeddb'
import { EditorView, minimalSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { BroadcastChannelProvider } from './y-bc'
import { tsserver } from './tsserver'
import { reload } from './ipc'

const doc = new Y.Doc()
const provider = new BroadcastChannelProvider('cm.ts', doc)
const persist = new IndexeddbPersistence('cm.ts', doc)
const text = doc.getText('index.ts')
const undoManager = new Y.UndoManager(text);

(globalThis as any).persist = persist

const userColor = random.oneOf([
  { color: '#30bced', light: '#30bced33' },
  { color: '#6eeb83', light: '#6eeb8333' },
  { color: '#ffbc42', light: '#ffbc4233' },
  { color: '#ecd444', light: '#ecd44433' },
  { color: '#ee6352', light: '#ee635233' },
  { color: '#9ac2c9', light: '#9ac2c933' },
  { color: '#8acb88', light: '#8acb8833' },
  { color: '#1be7ff', light: '#1be7ff33' }
])

provider.awareness.setLocalStateField('user', {
  name: Math.random().toString(36).slice(2),
  color: userColor.color,
  colorLight: userColor.light
})

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
      view.dom.parentElement!.classList.add('loaded')
    })
  : console.error('Failed to fetch TypeScript versions'));

(globalThis as any).view = new EditorView({
  doc: text.toString(),
  extensions: [
    minimalSetup,
    readOnly.of([
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ]),
    javascript({ typescript: true }),
    tsserver,
    yCollab(text, provider.awareness, { undoManager })
  ],
  parent: document.getElementById('editor')!
})
