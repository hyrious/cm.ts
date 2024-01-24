// Credit: y-websocket. This file only extracts the broadcast channel part of that module.

import * as Y from 'yjs'
import * as bc from 'lib0/broadcastchannel'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as authProtocol from 'y-protocols/auth'
import * as awarenessProtocol from 'y-protocols/awareness'
import { ObservableV2 } from 'lib0/observable'

const artificialSyncTimeout = 5000

const messageSync = 0
const messageAwareness = 1
const messageAuth = 2
const messageQueryAwareness = 3

const messageHandlers: Array<(
  encoder: encoding.Encoder,
  decoder: decoding.Decoder,
  provider: BroadcastChannelProvider,
  emitSynced: boolean,
  messageType: number,
) => void> = []

messageHandlers[messageSync] = (encoder, decoder, provider, emitSynced, _t) => {
  encoding.writeVarUint(encoder, messageSync)
  const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, provider.doc, provider)
  if (emitSynced && syncMessageType === syncProtocol.messageYjsSyncStep2) {
    provider.synced = true
  }
}

messageHandlers[messageQueryAwareness] = (encoder, _d, provider, _s, _t) => {
  encoding.writeVarUint(encoder, messageAwareness)
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(
    provider.awareness,
    Array.from(provider.awareness.getStates().keys())
  ))
}

messageHandlers[messageAwareness] = (_e, decoder, provider, _s, _t) => {
  awarenessProtocol.applyAwarenessUpdate(provider.awareness, decoding.readVarUint8Array(decoder), provider)
}

messageHandlers[messageAuth] = (_e, decoder, provider, _s, _t) => {
  authProtocol.readAuthMessage(decoder, provider.doc, (_, reason) => permissionDeniedHandler(provider, reason))
}

const permissionDeniedHandler = (provider: BroadcastChannelProvider, reason: string) =>
  console.warn(`Permission denied to access ${provider.bcChannel}.\n${reason}`)

const readMessage = (provider: BroadcastChannelProvider, buf: Uint8Array, emitSynced: boolean) => {
  const decoder = decoding.createDecoder(buf)
  const encoder = encoding.createEncoder()
  const messageType = decoding.readVarUint(decoder)
  const messageHandler = provider.messageHandlers[messageType]
  if (messageHandler) {
    messageHandler(encoder, decoder, provider, emitSynced, messageType)
  } else {
    console.error('Unable to compute message')
  }
  return encoder
}

const broadcastMessage = (provider: BroadcastChannelProvider, buf: Uint8Array) => {
  if (provider.bcconnected) {
    bc.publish(provider.bcChannel, buf, provider)
  }
}

export class BroadcastChannelProvider extends ObservableV2<{
  synced(state: boolean): void
}> {
  readonly messageHandlers = messageHandlers.slice()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)

  bcconnected = false

  private _synced = false
  get synced() { return this._synced }
  set synced(state) {
    if (this._synced !== state) {
      this._synced = state
      this.emit('synced', [state])
    }
  }

  constructor(readonly bcChannel: string, readonly doc: Y.Doc) {
    super()
    doc.on('update', this._updateHandler)
    window.addEventListener('unload', this._unloadHandler)
    this.awareness.on('update', this._awarenessHandler)
    this.connect()
  }

  private _bcSubscriber = (data: ArrayBuffer, origin: any) => {
    if (origin !== this) {
      setTimeout(() => {
        const encoder = readMessage(this, new Uint8Array(data), false)
        if (encoding.length(encoder) > 1) {
          bc.publish(this.bcChannel, encoding.toUint8Array(encoder), this)
        }
      }, artificialSyncTimeout)
    }
  }

  private _updateHandler = (update: Uint8Array, origin: any) => {
    if (origin !== this) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeUpdate(encoder, update)
      broadcastMessage(this, encoding.toUint8Array(encoder))
    }
  }

  private _awarenessHandler = ({ added, updated, removed }: { [type: string]: number[] }) => {
    const changedClients = added.concat(updated).concat(removed)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
    )
    broadcastMessage(this, encoding.toUint8Array(encoder))
  }

  private _unloadHandler = () => {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload')
  }

  override destroy() {
    this.disconnect()
    window.removeEventListener('unload', this._unloadHandler)
    this.awareness.off('update', this._awarenessHandler)
    this.doc.off('update', this._updateHandler)
    super.destroy()
  }

  connect() {
    if (!this.bcconnected) {
      bc.subscribe(this.bcChannel, this._bcSubscriber)
      this.bcconnected = true
    }
    // write sync step 1
    const encoderSync = encoding.createEncoder()
    encoding.writeVarUint(encoderSync, messageSync)
    syncProtocol.writeSyncStep1(encoderSync, this.doc)
    broadcastMessage(this, encoding.toUint8Array(encoderSync))
    // broadcast local state
    const encoderState = encoding.createEncoder()
    encoding.writeVarUint(encoderState, messageSync)
    syncProtocol.writeSyncStep2(encoderState, this.doc)
    broadcastMessage(this, encoding.toUint8Array(encoderState))
    // query awareness
    const encoderAwarenessQuery = encoding.createEncoder()
    encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness)
    broadcastMessage(this, encoding.toUint8Array(encoderAwarenessQuery))
    // broadcast awareness
    const encoderAwarenessState = encoding.createEncoder()
    encoding.writeVarInt(encoderAwarenessState, messageAwareness)
    encoding.writeVarUint8Array(encoderAwarenessState, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]))
    broadcastMessage(this, encoding.toUint8Array(encoderAwarenessState))
  }

  disconnect() {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID], new Map()))
    broadcastMessage(this, encoding.toUint8Array(encoder))
  }
}
