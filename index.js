import { EventEmitter } from 'eventemitter3';
import Protomux from 'protomux';
import { Duplex } from 'streamx';
import c from 'compact-encoding';
import b4a from 'b4a';
import BufferMap from 'tiny-buffer-map';
import {Subject, ReplaySubject, firstValueFrom, defaultIfEmpty} from 'rxjs';
import { concatMap } from 'rxjs/operators';

const PROTOCOL = 'protoplex/zacharygriffee';
globalThis.setImmediate ||= function setImmediate(cb) {
  return setTimeout(cb);
};

export class ProtoplexStream extends Duplex {
  constructor(plex, opts = {}) {
    // pull out an `onreject` callback (defaults to a no-op)
    const {
      id,
      handshake,
      handshakeEncoding,
      onhandshake,
      onreject = () => {},      // ← new
      encoding,
      unique,
      userData,
      protocol,
      incomingBufferSize = 100,
      incomingBufferTime = 10000,
      ...stream
    } = opts;

    super({ ...stream, eagerOpen: true });

    if (!(plex.mux?.isProtomux)) throw new Error('mux not an instance of Protomux!');

    this.plex = plex;
    this.mux = plex.mux;
    this.protocol = protocol || PROTOCOL;
    this.id = id ?? b4a.from([]);
    this.handshake = handshake ?? b4a.from([]);
    this.handshakeEncoding = handshakeEncoding ?? c.raw;
    this.encoding = encoding ? c.raw.array(encoding) : c.raw.array(c.raw);
    this.unique = unique ?? false;
    this.onhandshake = onhandshake ?? null;
    this.onreject = onreject ?? null;
    this.remoteHandshake = null;
    this.userData = userData ?? null;

    this.opened = false;

    // RxJS Subjects for data flow with configurable buffer size and time
    this.incoming$ = new ReplaySubject(incomingBufferSize, incomingBufferTime);
    this.outgoing$ = new Subject();
    this.drain$ = new Subject();

    this._onopen = null;
    this._openWith = null;
    this._incomingSub = null;

    this.channel = plex.mux.createChannel({
      protocol: this.protocol,
      id: this.id,
      handshake: this.handshakeEncoding,
      unique: this.unique,
      messages: [{ encoding: this.encoding, onmessage: this._onmessage.bind(this) }],
      onopen: handshake => this._onchannelopen(handshake),
      onclose: () => setImmediate(() => this.push(null)),
      ondestroy: () => setImmediate(() => this.destroy()),
      ondrain: () => this._onDrainEvent()
    });

    // Send outgoing data reactively
    this.outgoing$
        .pipe(
            concatMap(dataBatch => {
              if (!this.channel.messages[0].send(dataBatch)) {
                return firstValueFrom(this.drain$.pipe(defaultIfEmpty(true)));
              }
              return Promise.resolve(true);
            })
        )
        .subscribe({
          error: err => this._handleError(err)
        });

    this.channel.open(this.handshake);
  }

  _onDrainEvent() {
    this.drain$.next(true);
  }

  _writev(data, cb) {
    if (this.destroyed) {
      // Immediately reject writes if already being destroyed
      cb(new Error("Stream destroyed"));
      return;
    }
    this.outgoing$.next(data);
    cb(null);
  }

  _read(cb) {
    if (!this._incomingSub) {
      this._incomingSub = this.incoming$.subscribe({
        next: (data) => {
          const drained = this.push(data);
          if (!drained) {
            // Handle backpressure if necessary
          }
        },
        error: (err) => {
          // Handle error without termination
          console.error("Incoming stream error:", err);
          this.emit('error', err);
          // Alternatively continue, depends on desired behavior
        },
        complete: () => {
          if (!this.destroyed) this.push(null);
        }
      });
    }
    cb(null);
  }

  _final(cb) {
    this.channel?.close();
    cb(null);
  }

  _destroy(cb) {
    // this only runs when *this* Duplex is destroyed:
    this.channel.close();       // close the protocol channel
    this.incoming$.complete();
    this.outgoing$.complete();
    this.drain$.complete();
    if (this._incomingSub) {
      this._incomingSub.unsubscribe();
      this._incomingSub = null;
    }
    cb(null);
  }

  _predestroy() {
    this.opened = false;
    this.channel?.close();
    this._maybeOpen(new Error('Stream was destroyed!'));
  }

  _onmessage(batch) {
    if (!batch.length) {
      this.incoming$.next(b4a.alloc(0));
    } else {
      for (const data of batch) {
        this.incoming$.next(data);
      }
    }
  }

  async _onhandshake(handshake) {
    if (this.onhandshake) return this.onhandshake(handshake);
    return true;
  }

  _maybeOpen(err) {
    this._openWith = this._openWith ?? err;
    const cb = this._onopen;
    this._onopen = null;
    if (cb) {
      this.opened = true;
      cb(this._openWith);
    }
  }

  _handleError(err) {
    // 1) politely close our channel
    this.channel.close();
    // 2) destroy *this* ProtoplexStream
    this.destroy(err);
  }

  _open(cb) {
    this._onopen = cb;
    if (this.channel.opened) this._maybeOpen(null);
  }

  async _onchannelopen(handshake) {
    try {
      const shouldConnect = await this._onhandshake(handshake);
      if (!shouldConnect) {
        const err = new Error("Connection rejected by server");
        // 1) notify the callback
        this.onreject(err);
        // 2) emit a user-land event
        this.emit("reject", err);
        // 3) silently drop the socket
        this.channel.close();
        this.destroy();
        return;
      }

      // … everything you had here for the successful path …
      this.remoteHandshake = handshake;
      this.emit('connect');
      this._maybeOpen(null);

    } catch (err) {
      // if your onhandshake() threw, treat it exactly the same
      this.onreject(err);
      this.emit("reject", err);
      this.channel.close();
      this.destroy();
    }
  }

}

function toKey(id, protocol) {
  return !!id ? b4a.concat([b4a.from(protocol + '###'), id]) : b4a.from(protocol + '###');
}

export default class Protoplex extends EventEmitter {
  constructor(mux, opts = {}) {
    const {
      id,
      handshake,
      handshakeEncoding,
      onhandshake,
      encoding,
      unique,
      protocol,
      ...streamOpts
    } = opts;

    super();

    this.mux = mux;
    this.id = id ?? null;
    this.handshake = handshake ?? null;
    this.handshakeEncoding = handshakeEncoding ?? null;
    this.onhandshake = onhandshake ?? null;
    this.encoding = encoding ?? null;
    this.unique = unique ?? null;
    this.streamOpts = streamOpts ?? {};
    this.protocol = protocol || PROTOCOL;

    this._streams = new Set();
    this._listeners = new BufferMap();
  }

  static from(maybeMux, opts = {}) {
    const mux = maybeMux.isProtomux ? maybeMux : Protomux.from(maybeMux);
    return new Protoplex(mux, opts);
  }

  get isProtoplex() {
    return true;
  }

  listen(id, opts = {}) {
    if (!!id && !b4a.isBuffer(id)) {
      opts = id;
      id = null;
    }
    const protocol = opts.protocol || this.protocol || PROTOCOL;
    id = id ?? this.id;

    const listenId = toKey(id, protocol);
    if (this._listeners.has(listenId)) return this;
    this._listeners.set(listenId, opts);
    this.mux.pair({ protocol, id }, this._onpair.bind(this, protocol));

    return this;
  }

  unlisten(opts = {}) {
    const protocol = opts.protocol || this.protocol || PROTOCOL;
    const id = opts.id ?? this.id;

    const unlistenId = toKey(id, protocol);
    if (!this._listeners.has(unlistenId)) return this;
    this._listeners.delete(unlistenId);
    this.mux.unpair({ protocol, id });
    return this;
  }

  connect(id, _opts = {}) {
    if (!!id && !b4a.isBuffer(id)) {
      _opts = id;
      id = null;
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
    } = this;

    id = id ?? _id;
    const protocol = _opts.protocol || _protocol;

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
    };

    return new ProtoplexStream(this, opts);
  }

  _onpair(protocol, id) {
    const {
      id: _id,
      handshake,
      handshakeEncoding,
      onhandshake,
      encoding,
      unique,
      streamOpts
    } = this;

    id = id ?? _id;
    const key = toKey(id, protocol);
    const _opts = this._listeners.get(key) ?? {};

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
    };

    const stream = new ProtoplexStream(this, opts);
    this._streams.add(stream);
    stream.once('close', () => this._streams.delete(stream));
    this.emit('connection', stream);
  }

  [Symbol.iterator]() {
    return this._streams[Symbol.iterator]();
  }
}
