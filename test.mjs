import Protomux from 'protomux'
import {test, solo, skip} from 'brittle'
import c from 'compact-encoding'
import b4a from 'b4a'
import struct from 'compact-encoding-struct'
import FramedStream from 'framed-stream'
import duplexes from 'duplex-through'

import Protoplex from './index.js'
import {PassThrough} from "streamx";

test('should connect', async (t) => {
    t.plan(2)
    const {plexers: {server, client}} = testenv()
    server.on('connection', (stream) => {
        t.ok(stream)
    })
    server.listen()
    const stream = client.connect()
    stream.on('connect', () => {
        t.ok(stream)
    })
})

test('should connect on a given id', async (t) => {
    t.plan(2)
    const {plexers: {server, client}} = testenv()
    server.on('connection', (stream) => {
        t.ok(stream)
    })
    server.listen(b4a.from('address'))
    const stream = client.connect(b4a.from('address'))
    stream.once('connect', () => {
        t.ok(true)
    })
})

test('should connect on a given id and not another', async (t) => {
    t.plan(2)
    const {plexers: {server, client}} = testenv()
    server.on('connection', (stream) => {
        t.ok(stream.id.toString() === 'address')
    })
    server.listen(b4a.from('address'))
    client.connect(b4a.from('address'))
    const stream = client.connect(b4a.from('not listening'))
    stream.on('close', () => t.ok(true))
})

test('should propogate close from "server"', async (t) => {
    t.plan(2)
    const {plexers: {server, client}} = testenv()
    server.on('connection', (stream) => {
        t.ok(stream)
        stream.destroy()
    })
    server.listen()
    const stream = client.connect()
    stream.on('close', () => t.ok(true))
})

test('should propogate close from "client"', async (t) => {
    t.plan(1)
    const {plexers: {server, client}} = testenv()
    server.on('connection', (stream) => {
        stream.on('close', () => t.ok(true))
    })
    server.listen(b4a.from('1'))
    const stream = client.connect(b4a.from('1'))
    stream.once('connect', () => stream.destroy())
})

test('should send from "client" to "server"', async (t) => {
    t.plan(1);

    const {plexers: {server, client}} = testenv();
    const message = 'Hello, World!';

    server.on('connection', async (stream) => {
        let str = '';
        for await (const buf of stream) {
            str += buf.toString();
        }
        t.is(str, message);
    });

    server.listen();

    const stream = client.connect();
    stream.write(b4a.from(message));
    stream.end();

    stream.on('close', () => {
        console.log('[Test] Client stream closed');
    });
});

test("should send empty messages", async t => {
    t.plan(1);
    const {plexers: {server, client}} = testenv()
    const message = b4a.alloc(0);
    server.on('connection', async (stream) => {
        let b = await new Promise(resolve => stream.once("data", resolve));
        t.ok(b4a.equals(b, b4a.alloc(0)));
    })
    server.listen()
    const stream = client.connect()
    stream.write(message)
    stream.end()
});

test('should send from "client" to "server" pre-connect', async (t) => {
    t.plan(1)
    const {plexers: {server, client}} = testenv()
    const message = 'Hello, World!'
    server.on('connection', async (stream) => {
        let str = ''
        for await (const buf of stream) str += buf.toString()
        t.is(str, message)
    })
    server.listen()
    const stream = client.connect()
    stream.write(b4a.from(message))
    stream.end()
})

test('should send from "server" to "client"', async (t) => {
    t.plan(1)
    const {plexers: {server, client}} = testenv()
    const message = 'Hello, World!'

    server.on('connection', (stream) => {
        stream.write(b4a.from(message))
        stream.end()
    })

    server.listen()
    const stream = client.connect()

    let str = ''
    for await (const buf of stream) str += buf.toString()
    t.is(str, message)
})

test('should send from "server" to "client" a very large message', async (t) => {
    t.plan(1)
    const {plexers: {server, client}} = testenv()
    const message = b4a.from("x".repeat(1024 * 1024))

    server.on('connection', (stream) => {
        stream.write(message)
        stream.end()
    })

    server.listen()
    const stream = client.connect()

    let buffers;
    stream.once("data", data => {
        buffers = data;
    });

    stream.once("close", () => {
        t.ok(b4a.equals(message, buffers))
    });
})


test('it should send and recv messages from many clients', async (t) => {
    const count = Math.floor(Math.random() * ((Math.floor(Math.random() * 10)) * 10)) || 1
    t.plan(count)

    const {plexers: {server, client}} = testenv()
    const message = 'Hello, World!'

    server.on('connection', async (stream, id) => {
        let str = ''
        for await (const buf of stream) {
            str += buf.toString()
        }
        t.is(str, message)
    })
    server.listen()

    for (let i = 0; i < count; i++) {
        const stream = client.connect()
        stream.write(b4a.from(message))
        stream.end()
    }
})

test('it should support bidirectional servers & clients', async (t) => {
    const count = Math.floor(Math.random() * ((Math.floor(Math.random() * 10)) * 10)) || 2
    t.plan(count)

    const {plexers: {server, client}} = testenv()

    const message = 'Hello, World!'

    server.on('connection', async (stream) => {
        let str = ''
        for await (const buf of stream) str += buf.toString()
        t.is(str, message)
    })

    client.on('connection', async (stream) => {
        let str = ''
        for await (const buf of stream) str += buf.toString()
        t.is(str, message)
    })

    const id1 = b4a.from('1')
    const id2 = b4a.from('2')

    server.listen(id1)
    client.listen(id2)

    for (let i = 0; i < count; i++) {
        const mkstream = (i % 2 === 0) ? () => client.connect(id1) : () => server.connect(id2)
        const stream = mkstream()
        stream.write(Buffer.from(message))
        stream.end()
    }
})

test('it should support passing custom encodings', async (t) => {
    t.plan(1)

    const message = {greeting: 'Hello, World!'}
    const opts = {encoding: struct.compile({greeting: c.string})}

    const {plexers: {server, client}} = testenv({opts})

    server.on('connection', async (stream) => {
        for await (const msg of stream) t.is(msg.greeting, message.greeting)
    })

    server.listen()
    const stream = client.connect()
    stream.write(message)
    stream.end()
})

test('it should support different custom protocols and IDs', async (t) => {
    const protocols = ['custom-proto1', 'my-protocol2', 'test-protocol3', 'proto4', 'unique-protocol5']
    const ids = [b4a.from('1'), b4a.from('2'), b4a.from('3'), b4a.from('4'), b4a.from('5')]

    t.plan((protocols.length * ids.length) * 2)
    const {plexers: {server, client}} = testenv()

    const message = 'Hello, World!'

    server.on('connection', async (stream) => {
        let str = ''

        const chunk = await new Promise(resolve => stream.on("data", resolve));
        str += chunk.toString();

        t.is(str, message)
        stream.write(b4a.from(message));
    })

    for (const protocol of protocols) {
        for (const id of ids) {
            server.listen(id, {protocol})
            const stream = client.connect(id, {protocol});

            stream.write(b4a.from(message))

            const chunk = await new Promise(resolve => stream.once("data", resolve));
            t.is(message, chunk.toString())
        }
    }
})

test('big bidirectional write', async (t) => {
    t.plan(2)
    const {plexers: {server, client}} = testenv({opts: {encoding: c.raw}})
    const message = randomStr(100000)

    server.on('connection', async (stream) => {
        let str = ''
        for await (const buf of stream) {
            str += buf.toString()
        }
        t.is(str, message)
    })

    client.on('connection', async (stream) => {
        let str = ''
        for await (const buf of stream) {
            str += buf.toString()
        }
        t.is(str, message)
    })

    server.listen(b4a.from('server'))
    client.listen(b4a.from('client'))

    ;(async () => {
        const stream = client.connect(b4a.from('server'))
        let i = 0
        for (const char of message.split('')) {
            stream.write(Buffer.from(char))
            if (i++ % 10000 === 0) await new Promise((resolve) => setTimeout(resolve, 25 * Math.floor(Math.random() * 100)))
        }
        stream.end()
    })()

    ;(async () => {
        const stream = server.connect(b4a.from('client'))
        let i = 0
        for (const char of message.split('')) {
            stream.write(b4a.from(char))
            if (i++ % 10000 === 0) await new Promise((resolve) => setTimeout(resolve, 25 * Math.floor(Math.random() * 100)))
        }
        stream.end()
    })()
})

test('reject handshake does NOT destroy raw underlying stream', async t => {
    // 1) Create two piped PassThroughs
    const a = new PassThrough()
    const b = new PassThrough()
    a.pipe(b)
    b.pipe(a)

    // 2) Wrap them in Protomux muxers
    const muxA = Protomux.from(a)
    const muxB = Protomux.from(b)

    // 3) Set up server that ALWAYS rejects
    const server = new Protoplex(muxA)
    server.listen({ onhandshake: () => false }) ;
    const client = new Protoplex(muxB)
    const cliStream = client.connect()

    // 4) Wait for the server to spawn its ProtoplexStream
    const srvStream = await new Promise(resolve => server.once('connection', resolve));

    // 6) On the server stream, catch the custom 'reject' event
    const rejectErr = await new Promise(resolve => {
        srvStream.once('reject', resolve)
    })
    t.ok(rejectErr.message.includes("rejected by server"),'server-side got reject')

    // 7) Ensure the server stream never emits an 'error'
    let errored = false
    srvStream.on('error', () => { errored = true })
    await new Promise(r => setImmediate(r))
    t.not(errored, 'server-side did not emit error')
    t.ok(cliStream.destroyed, 'client-side stream is destroyed')

    // 9) The raw PassThroughs must still be open
    t.not(a.destroyed, 'raw stream A is still open')
    t.not(b.destroyed, 'raw stream B is still open')
})



function random(max = Number.MAX_SAFE_INTEGER) {
    return Math.floor(Math.random() * max)
}

function randomChar() {
    return String.fromCharCode(random(4))
}

function randomStr(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(i % chars.length); // Cyclic character pattern
    }
    return result;
}

function testenv({opts = {}} = {}) {
    const [a, b] = duplexes()

    const streams = {
        server: new FramedStream(a),
        client: new FramedStream(b)
    }

    const muxers = {
        server: new Protomux(streams.server),
        client: new Protomux(streams.client)
    }

    const [sopts, copts] = (Array.isArray(opts)) ? opts : [opts, opts]

    const plexers = {
        server: new Protoplex(muxers.server, {userData: 'server', ...sopts}),
        client: new Protoplex(muxers.client, {userData: 'client', ...copts})
    }

    return {streams, muxers, plexers}
}
