import stream from 'stream'
import { Connection } from './Connect'
import { createBinaryFrame } from './frame'

/**
 * 表示二进制帧的可写流
 */
export class OutStream extends stream.Writable {
  connection
  minSize
  /**
   * @param {Connection} connection
   * @param {number} minSize
   */
  constructor(connection: Connection, minSize: number) {
    super()
    this.connection = connection
    this.minSize = minSize
    this.on('finish', () => {
      if (this.connection.readyState === this.connection.OPEN) {
        // 如果不再连接，请忽略
        this.connection.socket.write(
          createBinaryFrame(
            this.buffer,
            !this.connection.server,
            !this.hasSent,
            true
          )
        )
      }
      this.connection.outStream = undefined
    })
  }
  private buffer = Buffer.alloc(0)
  private hasSent = false // 指示是否已发送任何帧
  /**
   * @param {Buffer} chunk
   * @param {BufferEncoding} encoding
   * @param {SocketCallBack} callback
   */
  _write(chunk: Buffer, encoding: BufferEncoding, callback: SocketCallBack) {
    this.buffer = Buffer.concat(
      [this.buffer, chunk],
      this.buffer.length + chunk.length
    )
    if (this.buffer.length >= this.minSize) {
      if (this.connection.readyState === this.connection.OPEN) {
        // Ignore if not connected anymore
        const frameBuffer = createBinaryFrame(
          this.buffer,
          !this.connection.server,
          !this.hasSent,
          false
        )
        this.connection.socket.write(frameBuffer, encoding, callback)
      }
      this.buffer = Buffer.alloc(0)
      this.hasSent = true
      if (this.connection.readyState !== this.connection.OPEN) {
        callback()
      }
    } else {
      callback()
    }
  }
}
