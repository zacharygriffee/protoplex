# Protoplex

Multiplexed streams over a protomux instance. Enables bi-directional clients and servers.

`npm install protoplex`

# Changes from Original Library

This fork of Protoplex includes the following modifications:

- **Node.js Dependencies Removed**: This version is browser-compatible and does not rely on Node-specific modules.
- **Custom Protocol Support**: Allows the use of different underlying protocols, making Protoplex suitable for various communication layers.
- **Error Handling for Duplicate Channels**: If a channel with the same ID and protocol is created and `unique = false`, an error is thrown instead of trying to open on `null`.
- **Removal of Async Iterable for Connections**: The async iterable interface for connections has been removed. Instead, users should listen for incoming connections using the standard event-based approach: `plex.on("connection", (stream) => {})`, as shown in the usage example below.

## Usage
```js
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import Protoplex from 'protoplex'
import { pipeline } from 'streamx'

const server = new Protoplex(new Protomux(new SecretStream(false)))
const client = new Protoplex(new Protomux(new SecretStream(true)))

// Setup a duplex pipeline between client and server streams
pipeline(
  client.mux.stream.rawStream,
  server.mux.stream.rawStream,
  client.mux.stream.rawStream
)

const message = Buffer.from('Hello, World!')

// Listen for incoming connections on the server side
server.on('connection', (stream) => {
  stream.on('data', (data) => {
    console.log(data.toString()) // prints 'Hello, World!'
  })
})

// Server listens on channel with ID '1'
server.listen(Buffer.from('1'))

// Client connects to server's channel and sends a message
let stream = client.connect(Buffer.from('1'))
stream.write(message)
stream.end()

// protoplex makes no distinction between clients and servers

// Listen for incoming connections on the client side
client.on('connection', (stream) => {
  stream.on('data', (data) => {
    console.log(data.toString()) // prints 'Hello, World!'
  })
})

// Client listens on channel with ID '2'
client.listen(Buffer.from('2'))

// Server connects to client's channel and sends a message
stream = server.connect(Buffer.from('2'))
stream.write(message)
stream.end()
```

## API

#### `const plex = new Protoplex(mux, [options])`

Options include:

```js
{
  id: b4a.from([]), // default id
  handshake: b4a.from([]), // default handshake value
  handshakeEncoding: c.raw, // default handshake encoding
  onhandshake: (handshake) => true, // default function to accept or reject connection
  encoding: c.raw, // default encoding for values in a stream
  unique: false, // whether the underlying protomux channels should allow multi opens for a given protcol, id pair
  ...streamOptions // the rest of the options are default options for the underlying Duplex streams
}
```

#### `const plex = Protoplex.from(muxOrStream, [options])`

Options passed through to `new Protoplex(mux, [options])`.

#### `const stream = plex.connect(id, [options])`

Options are the same as for `Protoplex.from` but override those defaults for.

#### `stream.on('connect')`

Emitted when the stream is opened and the handshake was accepted.

#### `plex.on('connection', (stream) => {})`

Emitted when a remote connection is opened, suitable for use in place of async iteration for connection handling.

