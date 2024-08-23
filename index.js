import { EventEmitter } from 'events'
import on from 'events.on'
import Protomux from 'protomux'
import { Duplex } from 'streamx'
import c from 'compact-encoding'
import b4a from 'b4a'
import BufferMap from 'tiny-buffer-map'
import FIFO from 'fast-fifo'

const PROTOCOL = 'protoplex/zacharygriffee'
globalThis.setImmediate ||= function setImmediate (cb) {
  return setTimeout(cb)
}

export class ProtoplexStream extends Duplex {
  mux = null
  channel = null

  protocol = PROTOCOL
  id = b4a.from([])
  handshake = b4a.from([])
  handshakeEncoding = c.raw
  encoding = c.raw.array(c.raw)
  unique = false

  onhandshake = null

  remoteHandshake = null

  _q = new FIFO()
  _ondrain = null
  _onopen = null
  _openWith = null

  opened = false

  constructor (mux, opts = {}) {
    const {
      id,
      handshake,
      handshakeEncoding,
      onhandshake,
      encoding,
      unique,
      userData,
      protocol,
      ...stream
    } = opts

    super({ ...stream, eagerOpen: true })

    if (!(mux?.isProtomux)) throw new Error('mux not an instance of Protomux!')

    this.mux = mux
    this.id = id ?? this.id
    this.handshake = handshake ?? this.handshake
    this.handshakeEncoding = handshakeEncoding ?? this.handshakeEncoding
    this.onhandshake = onhandshake ?? this.onhandshake
    this.encoding = (encoding) ? c.raw.array(encoding) : this.encoding
    this.unique = unique ?? this.unique
    this.userData = userData ?? null
    this.protocol = protocol || PROTOCOL

    this.channel = mux.createChannel({
      protocol: this.protocol,
      id: this.id,
      handshake: this.handshakeEncoding,
      unique: this.unique,
      messages: [{ encoding: this.encoding, onmessage: this._onmessage.bind(this) }],
      onopen: (handshake) => this._onchannelopen(handshake),
      onclose: () => {
        const endOuter = () => { if (!this.destroyed) this.push(null) }
        if (!this.opened) this._maybeOpen(null)
        setImmediate(endOuter)
      },
      ondestroy: () => {
        if (!this.opened) this._maybeOpen(null)
        setImmediate(this.destroy.bind(this))
      },
      ondrain: this._callondrain.bind(this)
    })

    this.channel.open(this.handshake)
  }

  _writev (data, cb) {
    try {
      if (this.channel.messages[0].send(data)) return cb(null)
      this._ondrain = cb
    } catch (err) {
      return cb(err)
    }
  }

  _read (cb) {
    this.channel.uncork()
    while (this._q.length && this.push(this._q.shift())) continue
    if (!this._q.isEmpty()) this.channel.cork()
    return cb(null)
  }

  _final (cb) {
    this.channel?.close()
    return cb(null)
  }

  _destroy (cb) {
    this.mux = null
    this.channel = null
    return cb(null)
  }

  _predestroy () {
    this.opened = false
    this.channel?.close()
    this._maybeOpen(new Error('Stream was destroyed!'))
  }

  _callondrain (err) {
    const cb = this._ondrain
    this._ondrain = null
    if (cb) return cb(err)
  }

  _onmessage (batch) {
    let drain = true
    for (const data of batch) {
      if (drain) drain = this.push(data)
      else this._q.push(data)
    }
    if (drain) this.channel.cork()
  }

  async _onhandshake (handshake) {
    if (this.onhandshake) return this.onhandshake(handshake)
    else return true
  }

  _maybeOpen (err) {
    this._openWith = this._openWith ?? err
    const cb = this._onopen
    this._onopen = null
    if (cb) {
      this.opened = true
      return cb(this._openWith)
    }
  }

  _open (cb) {
    this._onopen = cb
    if (this.channel.opened) this._maybeOpen(null)
  }

  async _onchannelopen (handshake) {
    try {
      const shouldConnect = await this._onhandshake(handshake)
      if (!shouldConnect) return this._maybeOpen(new Error('Connection Rejected!'))
      this.remoteHandshake = handshake
      this.emit('connect')
      return this._maybeOpen(null)
    } catch (err) {
      return this._maybeOpen(err)
    }
  }
}

function toKey (id, protocol) {
  return !!id ? b4a.concat([b4a.from(protocol + '###'), id]) : b4a.from(protocol + '###')
}

function fromKey (key) {
  const parts = key.toString().split('###')
  if (parts.length !== 2) throw new Error('Invalid key format')

  return { protocol: parts[0], id: b4a.from(parts[1]) }
}

export default class Protoplex extends EventEmitter {
  mux = null

  id = null
  handshake = null
  handshakeEncoding = null
  encoding = null
  unique = null
  streamOpts = {}
  protocol = PROTOCOL

  _streams = new Set()
  _listeners = new BufferMap()

  static from (maybeMux, opts = {}) {
    const mux = (maybeMux.isProtomux)
      ? maybeMux
      : Protomux.from(maybeMux)
    return new Protoplex(mux, opts)
  }

  get protocol () { return this._protocol }
  constructor (mux, opts = {}) {
    const {
      id,
      handshake,
      handshakeEncoding,
      onhandshake,
      encoding,
      unique,
      protocol,
      ...streamOpts
    } = opts

    super()

    this.mux = mux
    this.id = id ?? this.id
    this.handshake = handshake ?? this.handshake
    this.handshakeEncoding = handshakeEncoding ?? this.handshakeEncoding
    this.onhandshake = onhandshake ?? this.onhandshake
    this.encoding = encoding ?? this.encoding
    this.unique = unique ?? this.unique
    this.streamOpts = streamOpts ?? this.streamOpts
    this._protocol = protocol || PROTOCOL
  }

  listen (id, opts = {}) {
    if (!!id && !b4a.isBuffer(id)) {
      opts = id
      id = null
    }
    const protocol = opts.protocol || this.protocol || PROTOCOL
    id = id ?? this.id

    const listenId = toKey(id, protocol)
    if (this._listeners.has(listenId)) return this
    this._listeners.set(listenId, opts)
    this.mux.pair({ protocol, id }, this._onpair.bind(this, protocol))

    return this
  }

  unlisten (opts = {}) {
    const protocol = opts.protocol || this.protocol || PROTOCOL
    const id = opts.id ?? this.id

    const unlistenId = toKey(id, protocol)
    if (!this._listeners.has(unlistenId)) return this
    this._listeners.delete(unlistenId)
    this.mux.unpair({ protocol, id: id })
    return this
  }

  connect (id, _opts = {}) {
    if (!!id && !b4a.isBuffer(id)) {
      _opts = id
      id = null
    }

    const {
      protocol: _protocol,
      id: _id,
      handshake,
      handshakeEncoding,
      onhandshake,
      encoding,
      unique,
      streamOpts
    } = this

    id = id ?? _id
    const protocol = _opts.protocol || _protocol

    const opts = {
      protocol,
      handshake,
      handshakeEncoding,
      onhandshake,
      encoding,
      unique,
      ...streamOpts,
      ..._opts,
      id
    }

    return new ProtoplexStream(this.mux, opts)
  }

  _onpair (protocol, id) {
    const {
      id: _id,
      handshake,
      handshakeEncoding,
      onhandshake,
      encoding,
      unique,
      streamOpts
    } = this

    id = id ?? _id
    const key = toKey(id, protocol);
    const _opts = this._listeners.get(key) ?? {}

    const opts = {
      protocol,
      handshake,
      handshakeEncoding,
      onhandshake,
      encoding,
      unique,
      ...streamOpts,
      ..._opts,
      id
    }

    const stream = new ProtoplexStream(this.mux, opts)
    this._streams.add(stream)
    stream.once('close', () => this._streams.delete(stream))
    this.emit('connection', stream)
  }

  [Symbol.iterator] () { return this._streams[Symbol.iterator]() }

  [Symbol.asyncIterator] () { return on(this, 'connection') }
}
