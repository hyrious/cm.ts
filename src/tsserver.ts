// signatureHelp credits:
// https://github.com/codemirror/lsp-client/blob/-/src/signature.ts
// https://github.com/microsoft/vscode/blob/-/extensions/typescript-language-features/src/languageFeatures/signatureHelp.ts
import { EditorView } from 'codemirror';
import { StateField, type Extension, StateEffect } from '@codemirror/state';
import { hoverTooltip, showTooltip, Tooltip, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { autocompletion, completeFromList } from '@codemirror/autocomplete';
import { linter } from '@codemirror/lint';
import { sendIPC } from './ipc';

globalThis.sendIPC = sendIPC;

function drawSignatureHelp(view: EditorView, data: import('typescript').SignatureHelpItems) {
  let dom = document.createElement('div')
  dom.className = 'cm-signature-tooltip'
  let signature = data.items[data.selectedItemIndex]
  let sig = dom.appendChild(document.createElement('div'))
  sig.className = 'cm-signature'
  let prefix = signature.prefixDisplayParts.map(p => p.text).join('')
  let sep = signature.separatorDisplayParts.map(p => p.text).join('')
  let suffix = signature.suffixDisplayParts.map(p => p.text).join('')
  sig.appendChild(document.createTextNode(prefix))
  for (let i = 0; i < signature.parameters.length; i++) {
    let param = signature.parameters[i]
    let label = param.displayParts.map(p => p.text).join('')
    if (i === data.argumentIndex) {
      let active = sig.appendChild(document.createElement('span'))
      active.className = 'cm-active-parameter'
      active.textContent = label
    } else {
      sig.appendChild(document.createTextNode(label))
    }
    if (i !== signature.parameters.length - 1) {
      sig.appendChild(document.createTextNode(sep))
    }
  }
  sig.appendChild(document.createTextNode(suffix))
  if (signature.documentation) {
    let docs = dom.appendChild(document.createElement('div'))
    docs.className = 'cm-signature-documentation'
    docs.textContent = signature.documentation.map(p => p.text).join('')
  }
  return { dom }
}

const signatureEffect = StateEffect.define<{ data: import('typescript').SignatureHelpItems, pos: number } | null>()

class SignatureState {
  constructor(
    readonly data: import('typescript').SignatureHelpItems,
    readonly tooltip: Tooltip
  ) {}
}

const signatureState = StateField.define<SignatureState | null>({
  create() { return null },
  update(sig, tr) {
    for (let e of tr.effects) if (e.is(signatureEffect)) {
      if (e.value) {
        return new SignatureState(e.value.data, signatureTooltip(e.value.data, e.value.pos))
      } else {
        return null
      }
    }
    if (sig && tr.docChanged)
      return new SignatureState(sig.data, {...sig.tooltip, pos: tr.changes.mapPos(sig.tooltip.pos)})
    return sig
  },
  provide: f => showTooltip.from(f, sig => sig && sig.tooltip)
})

function signatureTooltip(data: import('typescript').SignatureHelpItems, pos: number): Tooltip {
  return {
    pos,
    above: true,
    create: view => drawSignatureHelp(view, data)
  }
}

function sameSignatures(a: import('typescript').SignatureHelpItems, b: import('typescript').SignatureHelpItems): boolean {
  return a.argumentIndex === b.argumentIndex && a.argumentCount === b.argumentCount &&
    a.applicableSpan.start === b.applicableSpan.start &&
    a.applicableSpan.length === b.applicableSpan.length &&
    a.items[a.selectedItemIndex].documentation.map(p => p.text).join('') ===
    b.items[a.selectedItemIndex].documentation.map(p => p.text).join('')
}

const triggerCharacters = '(,<'
const retriggerCharacters = ')'
const signaturePlugin = ViewPlugin.fromClass(class {
  activeRequest: { pos: number, drop: boolean } | null = null
  delayedRequest = 0

  update(update: ViewUpdate) {
    if (this.activeRequest) {
      if (update.selectionSet) {
        this.activeRequest.drop = true
        this.activeRequest = null
      } else if (update.docChanged) {
        this.activeRequest.pos = update.changes.mapPos(this.activeRequest.pos)
      }
    }

    const sigState = update.view.state.field(signatureState)
    let triggerCharacter = ''
    if (update.docChanged && update.transactions.some(tr => tr.isUserEvent('input.type'))) {
      update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        let ins = inserted.toString()
        if (ins) for (let ch of triggerCharacters + retriggerCharacters) {
          if (ins.indexOf(ch) >= 0) triggerCharacter = ch
        }
      })
    }

    if (triggerCharacter) {
      setTimeout(() => this.doRequest(update.view, !!sigState))
    } else if (sigState && update.selectionSet) {
      clearTimeout(this.delayedRequest)
      this.delayedRequest = setTimeout(() => {
        this.doRequest(update.view, true)
      }, 250)
    }
  }

  doRequest(view: EditorView, _isRetrigger: boolean) {
    clearTimeout(this.delayedRequest)
    let pos = view.state.selection.main.head
    if (this.activeRequest) this.activeRequest.drop = true
    let req = this.activeRequest = { pos, drop: false }
    sendIPC({ signatureHelp: pos }).catch(() => []).then(res => {
      if (req.drop) return
      let result = (res as any)?.signatureHelp as import('typescript').SignatureHelpItems | undefined
      if (result?.items.length) {
        let cur = view.state.field(signatureState)
        if (cur && sameSignatures(cur.data, result)) return
        view.dispatch({
          effects: signatureEffect.of({
            data: result,
            pos: cur?.tooltip.pos || req.pos
          })
        })
      } else if (view.state.field(signatureState)) {
        view.dispatch({ effects: signatureEffect.of(null) })
      }
    })
  }
})

export const tsserver: Extension = [
  EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      sendIPC({ docChanged: update.state.doc.toString() }).catch(() => []);
    }
  }),
  autocompletion({
    override: [
      async (ctx) => {
        const res = await sendIPC({ autocomplete: ctx.pos }).catch(() => []);
        if (!('autocomplete' in res) || !res.autocomplete) return null;
        return completeFromList(res.autocomplete)(ctx);
      }
    ]
  }),
  linter(async () => {
    const res = await sendIPC({ lint: true }).catch(() => []);
    if (!('lint' in res) || !res.lint) return [];
    return res.lint;
  }),
  hoverTooltip(async (_, pos) => {
    const res = await sendIPC({ hover: pos }).catch(() => []);
    if (!('hover' in res) || !res.hover) return null;
    return {
      pos,
      create() {
        const dom = document.createElement('div');
        dom.classList.add('cm-quickinfo-tooltip');
        dom.textContent = res.hover;
        return { dom };
      }
    };
  }),
  [
    signatureState,
    signaturePlugin,
  ],
  EditorView.baseTheme({
    '.cm-signature-tooltip': {
      padding: '2px 6px',
      borderRadius: '2.5px',
      position: 'relative',
      "& .cm-signature-documentation": {
        padding: "0",
        fontSize: "80%",
      },
      "& .cm-signature": {
        fontFamily: "monospace",
        textIndent: "1em hanging",
      },
      "& .cm-active-parameter": {
        fontWeight: "bold"
      },
    }
  })
];
