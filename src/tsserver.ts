import { EditorView } from 'codemirror';
import { Extension } from '@codemirror/state';
import { hoverTooltip } from '@codemirror/view';
import { autocompletion, completeFromList } from '@codemirror/autocomplete';
import { linter } from '@codemirror/lint';
import { sendIPC } from './ipc';

(globalThis as any).sendIPC = sendIPC;

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
];
