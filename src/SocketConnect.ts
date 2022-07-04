import crypto from 'crypto'
import { EventEmitter } from 'events'
import type { IncomingHttpHeaders } from 'http'
import type { Socket } from 'net'
import type { TLSSocket } from 'tls'
import { createToast } from './common'
import * as frame from './frame'
import { InStream } from './InStream'
import { OutStream } from './OutStream'
import { SocketApp } from './SocketApp'

export class AppConnection extends EventEmitter {
  readonly token
  readonly server
  readonly socket
  private readonly toast
  /** Sec-WebSocket-Key头 */
  private key?: string
  /** 标题名称和值的只读映射,标题名称小写 */
  readonly headers: IncomingHttpHeaders = {}
  /** socket协议 */
  private protocol?: string
  /** socket协议组 */
  private protocols?: string[]

  constructor(
    token: string,
    socket: Socket | TLSSocket,
    server: SocketApp,
    debuger: boolean,
    callback: () => void
  ) {
    super()
    this.token = token
    this.socket = socket
    this.server = server
    this.readyState = this.CONNECTING

    this.toast = createToast('SocketApp', debuger)

    this.socket.on('readable', () => this.doRead())
    this.socket.on('error', err => this.emit('error', err))
    const onclose = () => {
      if (
        this.readyState === this.CONNECTING ||
        this.readyState === this.OPEN
      ) {
        this.emit('close', 1006, '')
      }
      this.readyState = this.CLOSED
      if (this.frameBuffer instanceof InStream) {
        this.frameBuffer.end()
        this.frameBuffer = ''
      }
      if (this.outStream instanceof OutStream) {
        this.outStream.end()
        this.outStream = ''
      }
    }
    this.socket.once('close', onclose)
    this.socket.once('finish', onclose)
    if (callback) this.once('connect', callback)
  }

  /**
   * 发送指定标签
   * @param {string} sign 标签
   * @param {any} data 负载数据
   * @param {SocketCallBack} [callback] 将在最终写入数据时执行
   */
  sendSign(
    sign: string,
    data?: string | object,
    callback?: (err?: Error) => void
  ) {
    if (this.readyState === this.OPEN) {
      if (!this.outStream) {
        this.toast.log(
          `向连接[${this.token}]传出：${sign}${
            data
              ? typeof data === 'string'
                ? `\t${data}`
                : Object.entries(data)
                    .map(val => `${val[0]}:\t|${val[1]}`)
                    .join('\r\n')
              : ''
          }`
        )
        return this.socket.write(
          frame.createTextFrame(JSON.stringify({ sign, data }), false),
          callback
        )
      }
      return this.emit(
        'error',
        new Error('在发送完二进制帧之前，无法发送文本帧')
      )
    }
    return this.emit('error', new Error('无法向未打开的连接进行写入'))
  }
  /**
   * 发送指定字符串
   * @param {string} str
   * @param {SocketCallBack} [callback] 将在最终写入数据时执行
   */
  sendText(str: string, callback?: (err?: Error) => void) {
    if (this.readyState === this.OPEN) {
      if (!this.outStream) {
        this.toast.log(`向连接[${this.token}]传出：${str}`)
        return this.socket.write(frame.createTextFrame(str, false), callback)
      }
      return this.emit(
        'error',
        new Error('在发送完二进制帧之前，无法发送文本帧')
      )
    }
    return this.emit('error', new Error('无法向未打开的连接进行写入'))
  }
  /**
   * 立即发送一个Buffer
   * @param {Buffer} data
   * @param {SocketCallBack} [callback] 将在最终写入数据时执行
   */
  sendBinary(data: Buffer, callback?: (err?: Error) => void) {
    if (this.readyState === this.OPEN) {
      if (!this.outStream) {
        this.toast.log(`向连接[${this.token}]传出：二进制流`, data)
        return this.socket.write(
          frame.createBinaryFrame(data, false, true, true),
          callback
        )
      }
      return this.emit(
        'error',
        new Error('在发送完之前的二进制帧之前，无法发送更多的二进制帧')
      )
    }
    return this.emit('error', new Error('无法向未打开的连接进行写入'))
  }
  /**
   * 发送文本或二进制帧
   * @param {string|Buffer} data
   * @param {SocketCallBack} [callback] 将在最终写入数据时执行
   */
  send(data: string | Buffer, callback?: (err?: Error) => void) {
    if (typeof data === 'string') {
      this.sendText(data, callback)
    } else if (Buffer.isBuffer(data)) {
      this.sendBinary(data, callback)
    } else {
      throw new TypeError('数据应该是字符串或Buffer实例')
    }
  }
  /**
   * 关闭连接，发送关闭帧并等待响应
   * 如果连接未打开，请在不发送关闭帧的情况下关闭连接
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code: number, reason?: string) {
    if (this.readyState === this.OPEN) {
      this.socket.write(frame.createCloseFrame(code, reason, false))
      this.readyState = this.CLOSING
    } else if (this.readyState !== this.CLOSED) {
      this.socket.end()
      this.readyState = this.CLOSED
    }
    this.emit('close', code, reason)
  }

  /** 内部缓存区 */
  private buffer = Buffer.alloc(0)
  /** 从socket读取内容并对其进行处理 */
  private doRead() {
    const buffer = this.socket.read()
    if (!buffer) return
    this.buffer = Buffer.concat(
      [this.buffer, buffer],
      this.buffer.length + buffer.length
    )
    if (this.readyState === this.CONNECTING && !this.readHandshake()) return
    if (this.readyState !== this.CLOSED) {
      let temp
      while ((temp = this.extractFrame()) === true) {}
      if (temp === false) this.close(1002)
      else if (this.buffer.length > AppConnection.maxBufferLength)
        this.close(1009)
    }
  }
  /**
   * 尝试从内部缓冲区读取握手
   * 如果成功，握手数据将从内部缓冲区消耗
   * @returns { boolean } 握手是否结束
   */
  private readHandshake(): boolean {
    if (this.buffer.length > AppConnection.maxBufferLength) {
      this.socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return false
    }
    let i,
      found = false
    for (i = 0; i < this.buffer.length - 3; i++) {
      if (
        this.buffer[i] === 13 &&
        this.buffer[i + 2] === 13 &&
        this.buffer[i + 1] === 10 &&
        this.buffer[i + 3] === 10
      ) {
        found = true
        break
      }
    }
    if (!found) return false
    const data = this.buffer
      .slice(0, i + 4)
      .toString()
      .split('\r\n')
    if (this.answerHandshake(data)) {
      this.buffer = this.buffer.slice(i + 4)
      this.readyState = this.OPEN
      this.emit('connect')
      return true
    } else {
      this.socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return false
    }
  }
  /**
   * 处理并回应客户发起的握手
   * @param {string[]} lines 每个“\r\n”分隔的HTTP请求行对应一个
   * @returns {boolean} 如果握手成功。否则，连接必须关闭，错误为400错误请求
   */
  private answerHandshake(lines: string[]): boolean {
    if (lines.length < 6) return false
    if (!lines[0].match(/^GET (.+) HTTP\/\d\.\d$/i)) return false
    this.readHeaders(lines)
    for (const head of [
      'host',
      'sec-websocket-key',
      'upgrade',
      'connection'
    ] as const) {
      if (!this.headers[head]) return false
    }
    if (
      this.headers.upgrade?.toLowerCase() !== 'websocket' ||
      this.headers.connection
        ?.toLowerCase()
        .split(/\s*,\s*/)
        .indexOf('upgrade') === -1
    )
      return false
    if (this.headers['sec-websocket-version'] !== '13') return false
    this.key = this.headers['sec-websocket-key']
    if (this.headers['sec-websocket-protocol']) {
      this.protocols = this.headers['sec-websocket-protocol']
        ?.split(',')
        .map(each => each.trim())
      if (this.server?._selectProtocol) {
        this.protocol = this.server._selectProtocol(this, this.protocols)
      }
    }
    const sha1 = crypto.createHash('sha1')
    sha1.end(this.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    const key = sha1.read().toString('base64')
    const headers: IncomingHttpHeaders = {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-accept': key
    }
    this.protocol && (headers['sec-websocket-protocol'] = this.protocol)
    this.socket.write(buildRequest('HTTP/1.1 101 Switching Protocols', headers))
    return true
  }

  /**
   * 从HTTP协议读取头
   * 更新headers属性
   * @param {string[]} lines 每个“\r\n”分隔的HTTP请求行对应一个
   */
  private readHeaders(lines: string[]) {
    lines.forEach(line => {
      const match = line.match(/^([a-z-]+): (.+)$/i)
      match && (this.headers[match[1].toLowerCase()] = match[2])
    })
  }

  /** 用于文本帧的String和用于二进制帧的InStream */
  private frameBuffer?: InStream | string = ''
  /** 当前分配的用于发送二进制帧的OutStream */
  public outStream?: OutStream | string = ''
  /**
   * 尝试从缓冲区提取帧内容（并执行）
   * @returns {boolean|undefined} true=帧已成功获取并执行;false=出现问题（必须关闭连接）;undefined=没有足够的数据捕获帧
   */
  private extractFrame(): boolean | undefined {
    if (this.buffer.length < 2) return
    let B = this.buffer[0]
    const HB = B >> 4
    if (HB % 8) return false
    const fin = HB === 8
    const opcode = B % 16
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) return false
    if (opcode >= 8 && !fin) return false
    B = this.buffer[1]
    const hasMask = B >> 7
    if (this.server && !hasMask) return false
    let len = B % 128
    let start = hasMask ? 6 : 2
    if (this.buffer.length < start + len) return
    if (len === 126) {
      len = this.buffer.readUInt16BE(2)
      start += 2
    } else if (len === 127) {
      len =
        this.buffer.readUInt32BE(2) * Math.pow(2, 32) +
        this.buffer.readUInt32BE(6)
      start += 8
    }
    if (this.buffer.length < start + len) return
    const payload = this.buffer.slice(start, start + len)
    if (hasMask) {
      const mask = this.buffer.slice(start - 4, start)
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4]
      }
    }
    this.buffer = this.buffer.slice(start + len)
    return this.processFrame(fin, opcode, payload)
  }
  /**
   * 处理接收到的给定帧
   * @param {boolean} fin
   * @param {number} opcode
   * @param {Buffer} payload
   * @returns {boolean} 如果出现任何错误，则为false，否则为true
   */
  private processFrame(fin: boolean, opcode: number, payload: Buffer): boolean {
    if (opcode === 8) {
      if (this.readyState === this.CLOSING) this.socket.end()
      else if (this.readyState === this.OPEN) this.processCloseFrame(payload)
      return true
    } else if (opcode === 9) {
      if (this.readyState === this.OPEN)
        this.socket.write(frame.createPongFrame(payload.toString(), false))
      return true
    } else if (opcode === 10) {
      this.emit('pong', payload.toString())
      return true
    }
    if (this.readyState !== this.OPEN) return true
    if (opcode === 0 && !this.frameBuffer) return false
    else if (opcode !== 0 && this.frameBuffer) return false
    if (typeof this.frameBuffer === 'string') {
      opcode = 1
      const payload_string = payload.toString()
      this.frameBuffer = this.frameBuffer
        ? this.frameBuffer + payload_string
        : payload_string
      if (fin) {
        this.emit('text', this.frameBuffer)
        this.frameBuffer = ''
      }
    } else {
      opcode = 2
      if (!this.frameBuffer) {
        this.frameBuffer = new InStream()
        this.emit('binary', this.frameBuffer)
      }
      this.frameBuffer.addData(payload)
      if (fin) {
        this.frameBuffer.end()
        this.frameBuffer = ''
      }
    }
    return true
  }
  /**
   * 处理关闭帧，发出关闭事件并发回帧
   * @param {Buffer} payload
   * @fires close
   */
  private processCloseFrame(payload: Buffer) {
    let code, reason
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0)
      reason = payload.slice(2).toString()
    } else {
      code = 1005
      reason = ''
    }
    this.socket.write(frame.createCloseFrame(code, reason, false))
    this.readyState = this.CLOSED
    this.emit('close', code, reason)
  }

  /** 连接就绪状态 */
  public readyState:
    | AppConnection['CONNECTING']
    | AppConnection['OPEN']
    | AppConnection['CLOSING']
    | AppConnection['CLOSED']
  /** @constant 连接的可能就绪状态--连接中 */
  readonly CONNECTING = 0
  /** @constant 连接的可能就绪状态--已连接 */
  readonly OPEN = 1
  /** @constant 连接的可能就绪状态--关闭中 */
  readonly CLOSING = 2
  /** @constant 连接的可能就绪状态--已关闭 */
  readonly CLOSED = 3

  /** 在单个帧中发送的二进制数据包的最小大小 */
  static binaryFragmentation = 512 * 1024 // .5 MiB
  /**
   * 内部缓冲区可以增长的最大大小
   * 如果它大于此值，连接将以code:1009关闭
   * 这是一种安全措施，以避免内存攻击
   */
  static maxBufferLength = 2 * 1024 * 1024 // 2 MiB
}

/**
 * 构建标题字符串
 * @param {string} requestLine
 * @param {IncomingHttpHeaders} headers
 * @returns {string}
 */
function buildRequest(
  requestLine: string,
  headers: IncomingHttpHeaders
): string {
  let headerString = requestLine + '\r\n'
  for (const [key, val] of Object.entries(headers)) {
    headerString += key + ': ' + val + '\r\n'
  }
  return headerString + '\r\n'
}
