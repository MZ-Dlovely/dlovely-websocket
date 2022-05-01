import { EventEmitter } from 'events'
import crypto from 'crypto'
import type { Socket } from 'net'
import type { TLSSocket } from 'tls'
import type { IncomingHttpHeaders } from 'http'
import { Server } from './Server'
import { InStream } from './InStream'
import { OutStream } from './OutStream'
import * as frame from './frame'

export type ConnectionProtocol = string
interface ConnectionHeaders
  extends Record<string, string | string[] | undefined>,
    IncomingHttpHeaders {}
export interface ConnectionOptions {
  secure:boolean
  path?: string
  host?: string
  port: number
  extraHeaders?: ConnectionHeaders
  protocols?: ConnectionProtocol[]
}
interface ConnectionCallback {
  (): void
}

export class Connection extends EventEmitter {
  public readonly server?: Server
  private path?: ConnectionOptions['path']
  private host?: ConnectionOptions['host']
  private extraHeaders?: ConnectionOptions['extraHeaders']
  private protocols?: ConnectionOptions['protocols']
  constructor(
    socket: Socket | TLSSocket,
    parentOrOptions: Server | ConnectionOptions,
    callback?: ConnectionCallback
  ) {
    super()
    if (parentOrOptions instanceof Server) {
      // Server-side connection
      this.server = parentOrOptions
    } else {
      // Client-side
      this.path = parentOrOptions.path
      this.host = parentOrOptions.host
      this.extraHeaders = parentOrOptions.extraHeaders
      this.protocols = parentOrOptions.protocols || []
    }
    this.socket = socket
    this.readyState = this.CONNECTING
    // Set listeners
    socket.on('readable', () => {
      this.doRead()
    })
    socket.on('error', err => {
      this.emit('error', err)
    })

    if (!this.server) {
      socket.on(
        socket.constructor.name === 'TLSSocket' ? 'secureConnect' : 'connect',
        () => {
          this.startHandshake()
        }
      )
    }

    // Close listeners
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
        this.frameBuffer = undefined
      }
      if (this.outStream instanceof OutStream) {
        this.outStream.end()
        this.outStream = undefined
      }
    }
    socket.once('close', onclose)
    socket.once('finish', onclose)
    if (callback) this.once('connect', callback)
  }
  private protocol?: ConnectionProtocol
  public readonly socket
  public readyState: 0 | 1 | 2 | 3
  private buffer = Buffer.alloc(0)
  private frameBuffer?: InStream | string // 用于文本帧的String和用于二进制帧的InStream
  public outStream?: OutStream | string // 当前分配的用于发送二进制帧的OutStream
  private key?: string // Sec-WebSocket-Key头
  private headers: ConnectionHeaders = {} // 标题名称和值的只读映射,标题名称小写

  /**
   * 在单个帧中发送的二进制数据包的最小大小
   */
  static binaryFragmentation = 512 * 1024 // .5 MiB
  /**
   * 内部缓冲区可以增长的最大大小
   * 如果它大于此值，连接将以code:1009关闭
   * 这是一种安全措施，以避免内存攻击
   */
  static maxBufferLength = 2 * 1024 * 1024 // 2 MiB
  /**
   * 连接的可能就绪状态
   */
  public readonly CONNECTING = 0
  public readonly OPEN = 1
  public readonly CLOSING = 2
  public readonly CLOSED = 3

  /**
   * 发送指定字符串
   * @param {string} str
   * @param {SocketCallBack} [callback] 将在最终写入数据时执行
   */
  sendText(str: string, callback: SocketCallBack) {
    if (this.readyState === this.OPEN) {
      if (!this.outStream)
        return this.socket.write(
          frame.createTextFrame(str, !this.server),
          callback
        )
      return this.emit(
        'error',
        new Error('在发送完二进制帧之前，无法发送文本帧')
      )
    }
    return this.emit('error', new Error('无法向未打开的连接进行写入'))
  }

  /**
   * 请求OutStream发送二进制数据
   */
  beginBinary() {
    if (this.readyState === this.OPEN) {
      if (!this.outStream) {
        return (this.outStream = new OutStream(
          this,
          Connection.binaryFragmentation
        ))
      }
      return this.emit(
        'error',
        new Error('在发送完之前的二进制帧之前，无法发送更多的二进制帧')
      )
    }
    return this.emit('error', new Error('无法向未打开的连接进行写入'))
  }

  /**
   * 立即发送一个Buffer
   * @param {Buffer} data
   * @param {SocketCallBack} [callback] 将在最终写入数据时执行
   */
  sendBinary(data: Buffer, callback: SocketCallBack) {
    if (this.readyState === this.OPEN) {
      if (!this.outStream) {
        return this.socket.write(
          frame.createBinaryFrame(data, !this.server, true, true),
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
  send(data: string | Buffer, callback: SocketCallBack) {
    if (typeof data === 'string') {
      this.sendText(data, callback)
    } else if (Buffer.isBuffer(data)) {
      this.sendBinary(data, callback)
    } else {
      throw new TypeError('数据应该是字符串或Buffer实例')
    }
  }
  /**
   * 向远程服务器发送ping
   * @param {string} [data=''] - 可选ping数据
   * @fires pong 当收到pong回复时
   */
  sendPing(data: string = '') {
    if (this.readyState === this.OPEN) {
      this.socket.write(frame.createPingFrame(data, !this.server))
    } else {
      this.emit('error', new Error("You can't write to a non-open connection"))
    }
  }
  /**
   * 关闭连接，发送关闭帧并等待响应
   * 如果连接未打开，请在不发送关闭帧的情况下关闭连接
   * @param {number} [code]
   * @param {string} [reason]
   * @fires close
   */
  close(code: number, reason?: string) {
    if (this.readyState === this.OPEN) {
      this.socket.write(frame.createCloseFrame(code, reason, !this.server))
      this.readyState = this.CLOSING
    } else if (this.readyState !== this.CLOSED) {
      this.socket.end()
      this.readyState = this.CLOSED
    }
    this.emit('close', code, reason)
  }
  /**
   * 从socket读取内容并对其进行处理
   * @fires connect
   */
  doRead() {
    // 读取数据
    const buffer = this.socket.read()
    if (!buffer) return
    // 保存到内部缓冲区
    this.buffer = Buffer.concat(
      [this.buffer, buffer],
      this.buffer.length + buffer.length
    )
    if (this.readyState === this.CONNECTING && !this.readHandshake()) return
    if (this.readyState !== this.CLOSED) {
      let temp
      while ((temp = this.extractFrame()) === true) {}
      if (temp === false) {
        // 协议错误
        this.close(1002)
      } else if (this.buffer.length > Connection.maxBufferLength) {
        // 帧过大
        this.close(1009)
      }
    }
  }
  /**
   * 客户端创建并发送握手
   */
  startHandshake() {
    const key = Buffer.alloc(16)
    for (let i = 0; i < 16; i++) {
      key[i] = Math.floor(Math.random() * 256)
    }
    this.key = key.toString('base64')
    const headers: ConnectionHeaders = {
      host: this.host,
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': this.key,
      'sec-websocket-version': '13'
    }
    if (this.protocols?.length) {
      headers['sec-websocket-protocol'] = this.protocols.join(', ')
    }
    for (const header in this.extraHeaders) {
      headers[header] = this.extraHeaders[header]
    }
    this.socket.write(
      this.buildRequest('GET ' + this.path + ' HTTP/1.1', headers)
    )
  }
  /**
   * 尝试从内部缓冲区读取握手
   * 如果成功，握手数据将从内部缓冲区消耗
   * @returns {boolean} - 握手是否结束
   */
  readHandshake(): boolean {
    var found = false
    // 握手并尝试连接
    if (this.buffer.length > Connection.maxBufferLength) {
      // Too big for a handshake
      if (this.server) {
        this.socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } else {
        this.socket.end()
        this.emit('error', new Error('Handshake is too big'))
      }
      return false
    }
    // 检索'\r\n\r\n'
    let i
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
    if (this.server ? this.answerHandshake(data) : this.checkHandshake(data)) {
      this.buffer = this.buffer.slice(i + 4)
      this.readyState = this.OPEN
      this.emit('connect')
      return true
    } else {
      this.socket.end(this.server ? 'HTTP/1.1 400 Bad Request\r\n\r\n' : '')
      return false
    }
  }
  /**
   * 从HTTP协议读取头
   * 更新headers属性
   * @param {string[]} lines 每个“\r\n”分隔的HTTP请求行对应一个
   */
  readHeaders(lines: string[]) {
    let match
    // Extract all headers
    // Ignore bad-formed lines and ignore the first line (HTTP header)
    for (let i = 1; i < lines.length; i++) {
      if ((match = lines[i].match(/^([a-z-]+): (.+)$/i))) {
        this.headers[match[1].toLowerCase()] = match[2]
      }
    }
  }
  /**
   * 处理并检查服务器的握手应答
   * @param {string[]} lines 每个“\r\n”分隔的HTTP请求行对应一个
   * @returns {boolean} 如果握手成功，否则，必须关闭连接
   */
  checkHandshake(lines: string[]): boolean {
    // 首行
    if (lines.length < 4) {
      this.emit('error', new Error('无效握手：太短'))
      return false
    }
    if (!lines[0].match(/^HTTP\/\d\.\d 101( .*)?$/i)) {
      this.emit('error', new Error('无效握手：无效的首行格式'))
      return false
    }
    // 提取所有标题
    this.readHeaders(lines)
    // Validate necessary headers
    if (
      !('upgrade' in this.headers) ||
      !('sec-websocket-accept' in this.headers) ||
      !('connection' in this.headers)
    ) {
      this.emit('error', new Error('无效握手：缺少必需的头部'))
      return false
    }
    if (
      this.headers.upgrade?.toLowerCase() !== 'websocket' ||
      this.headers.connection
        ?.toLowerCase()
        .split(/\s*,\s*/)
        .indexOf('upgrade') === -1
    ) {
      this.emit('error', new Error('无效握手：Upgrade或连接头无效'))
      return false
    }
    const key = this.headers['sec-websocket-accept']
    // Check protocol negotiation
    const protocol = this.headers['sec-websocket-protocol']
    if (this.protocols?.length) {
      // The server must choose one from our list
      if (!protocol || this.protocols.indexOf(protocol) === -1) {
        this.emit('error', new Error('无效握手：未协商任何协议'))
        return false
      }
    } else {
      // The server must not choose a protocol
      if (protocol) {
        this.emit('error', new Error('无效握手：不应进行协议协商'))
        return false
      }
    }
    this.protocol = protocol
    // Check the key
    const sha1 = crypto.createHash('sha1')
    sha1.end(this.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    if (key !== sha1.read().toString('base64')) {
      this.emit('error', new Error('无效握手：hash不匹配'))
      return false
    }
    return true
  }
  /**
   * 处理并回应客户发起的握手
   * @param {string[]} lines 每个“\r\n”分隔的HTTP请求行对应一个
   * @returns {boolean} 如果握手成功。否则，连接必须关闭，错误为400错误请求
   * @private
   */
  answerHandshake(lines: string[]): boolean {
    // 首行
    if (lines.length < 6) return false
    const path = lines[0].match(/^GET (.+) HTTP\/\d\.\d$/i)
    if (!path) return false
    this.path = path[1]
    // 提取所有标题
    this.readHeaders(lines)
    // Validate necessary headers
    if (
      !('host' in this.headers) ||
      !('sec-websocket-key' in this.headers) ||
      !('upgrade' in this.headers) ||
      !('connection' in this.headers)
    )
      return false
    if (
      this.headers.upgrade?.toLowerCase() !== 'websocket' ||
      this.headers.connection
        ?.toLowerCase()
        .split(/\s*,\s*/)
        .indexOf('upgrade') === -1
    ) {
      return false
    }
    if (this.headers['sec-websocket-version'] !== '13') return false
    this.key = this.headers['sec-websocket-key']
    // 协议达成一致
    if ('sec-websocket-protocol' in this.headers) {
      // 分析
      this.protocols = this.headers['sec-websocket-protocol']
        ?.split(',')
        .map(each => each.trim())
      // 选择协议
      if (this.server?._selectProtocol) {
        this.protocol = this.server._selectProtocol(this, this.protocols)
      }
    }
    // 构建并发送响应
    const sha1 = crypto.createHash('sha1')
    sha1.end(this.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    const key = sha1.read().toString('base64')
    const headers: ConnectionHeaders = {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-accept': key
    }
    if (this.protocol) headers['sec-websocket-protocol'] = this.protocol
    this.socket.write(
      this.buildRequest('HTTP/1.1 101 Switching Protocols', headers)
    )
    return true
  }

  /**
   * 尝试从缓冲区提取帧内容（并执行）
   * @returns {(boolean|undefined)} true=帧已成功获取并执行;false=出现问题（必须关闭连接）;undefined=没有足够的数据捕获帧
   */
  extractFrame(): boolean | undefined {
    if (this.buffer.length < 2) return
    // 判断是否最后一帧
    let B = this.buffer[0]
    const HB = B >> 4
    if (HB % 8) {
      // RSV1, RSV2 and RSV3 must be clear
      return false
    }
    const fin = HB === 8
    const opcode = B % 16

    if (
      opcode !== 0 &&
      opcode !== 1 &&
      opcode !== 2 &&
      opcode !== 8 &&
      opcode !== 9 &&
      opcode !== 10
    )
      return false
    if (opcode >= 8 && !fin) return false
    B = this.buffer[1]
    const hasMask = B >> 7
    if ((this.server && !hasMask) || (!this.server && hasMask)) {
      // Frames sent by clients must be masked
      return false
    }
    let len = B % 128
    let start = hasMask ? 6 : 2
    if (this.buffer.length < start + len) return
    // 获取实际有效载荷长度
    if (len === 126) {
      len = this.buffer.readUInt16BE(2)
      start += 2
    } else if (len === 127) {
      // 警告：JS最多只能以数字格式存储2^53
      len =
        this.buffer.readUInt32BE(2) * Math.pow(2, 32) +
        this.buffer.readUInt32BE(6)
      start += 8
    }
    if (this.buffer.length < start + len) return
    // 提取负载
    const payload = this.buffer.slice(start, start + len)
    if (hasMask) {
      // Decode with the given mask
      const mask = this.buffer.slice(start - 4, start)
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4]
      }
    }
    this.buffer = this.buffer.slice(start + len)
    // Proceeds to frame processing
    return this.processFrame(fin, opcode, payload)
  }

  /**
   * 处理接收到的给定帧
   * @param {boolean} fin
   * @param {number} opcode
   * @param {Buffer} payload
   * @returns {boolean} 如果出现任何错误，则为false，否则为true
   * @fires text
   * @fires binary
   */
  processFrame(fin: boolean, opcode: number, payload: Buffer): boolean {
    if (opcode === 8) {
      // 关闭帧
      if (this.readyState === this.CLOSING) this.socket.end()
      else if (this.readyState === this.OPEN) this.processCloseFrame(payload)
      return true
    } else if (opcode === 9) {
      // Ping帧
      if (this.readyState === this.OPEN)
        this.socket.write(
          frame.createPongFrame(payload.toString(), !this.server)
        )
      return true
    } else if (opcode === 10) {
      // Pong帧
      this.emit('pong', payload.toString())
      return true
    }
    if (this.readyState !== this.OPEN) {
      // 连接未打开则忽略
      return true
    }
    if (opcode === 0 && this.frameBuffer === null) {
      // 意外的连续帧
      return false
    } else if (opcode !== 0 && this.frameBuffer !== null) {
      // 最后一个序列没有正确完成
      return false
    }
    // 获取碎片帧的当前操作码
    if (typeof this.frameBuffer === 'string') {
      opcode = 1
      // 保存文本帧
      const payload_string = payload.toString()
      this.frameBuffer = this.frameBuffer
        ? this.frameBuffer + payload_string
        : payload_string
      if (fin) {
        // Emits 'text' event
        this.emit('text', this.frameBuffer)
        this.frameBuffer = undefined
      }
    } else {
      opcode = 2
      // 发送InStream对象的缓冲区
      if (!this.frameBuffer) {
        // Emits the 'binary' event
        this.frameBuffer = new InStream()
        this.emit('binary', this.frameBuffer)
      }
      this.frameBuffer.addData(payload)
      if (fin) {
        // Emits 'end' event
        this.frameBuffer.end()
        this.frameBuffer = undefined
      }
    }
    return true
  }

  /**
   * 处理关闭帧，发出关闭事件并发回帧
   * @param {Buffer} payload
   * @fires close
   */
  processCloseFrame(payload: Buffer) {
    let code, reason
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0)
      reason = payload.slice(2).toString()
    } else {
      code = 1005
      reason = ''
    }
    this.socket.write(frame.createCloseFrame(code, reason, !this.server))
    this.readyState = this.CLOSED
    this.emit('close', code, reason)
  }

  /**
   * 构建标题字符串
   * @param {string} requestLine
   * @param {ConnectionHeaders} headers
   * @returns {string}
   */
  buildRequest(requestLine: string, headers: ConnectionHeaders): string {
    let headerString = requestLine + '\r\n'
    for (const headerName in headers) {
      headerString += headerName + ': ' + headers[headerName] + '\r\n'
    }
    return headerString + '\r\n'
  }
}
