import net from 'net'
import tls from 'tls'
import { EventEmitter } from 'events'
import { Connection, ConnectionProtocol } from './Connect'

interface ServerProtocolCallback {
  (conn: Connection, protocols?: ConnectionProtocol[]):
    | ConnectionProtocol
    | undefined
}
export interface ServerOptions extends tls.TlsOptions {
  secure?: boolean
  selectProtocol?: ServerProtocolCallback
  validProtocols?: string[]
}
interface ServerCallback {
  (): void
}

function nop() {}

export class Server extends EventEmitter {
  private socket
  public readonly connections: Connection[]
  constructor(secure: boolean, callback?: ServerCallback)
  constructor(
    secure: boolean,
    options?: ServerOptions,
    callback?: ServerCallback
  )
  constructor(
    secure: boolean,
    options: ServerOptions | ServerCallback = {},
    callback?: ServerCallback
  ) {
    super()
    if (typeof options === 'function') {
      callback = options as ServerCallback
      options = {}
    }
    const onConnection = (socket: net.Socket | tls.TLSSocket) => {
      const conn = new Connection(socket, this, () => {
        this.connections.push(conn)
        conn.removeListener('error', nop)
        this.emit('connection', conn)
      })
      conn.on('close', () => {
        const pos = this.connections.indexOf(conn)
        if (pos !== -1) this.connections.splice(pos, 1)
      })
      // 在建立连接之前忽略错误
      conn.on('error', nop)
    }
    this.socket = secure
      ? tls.createServer(options, onConnection)
      : net.createServer(options, onConnection)
    this.socket.on('close', () => {
      this.emit('close')
    })
    this.socket.on('error', err => {
      this.emit('error', err)
    })
    this.connections = []
    if (callback) this.on('connection', callback)
    if (options?.selectProtocol) {
      // 用户提供的逻辑
      this._selectProtocol = options.selectProtocol
    } else if (options?.validProtocols) {
      // 默认逻辑
      this._selectProtocol = this._buildSelectProtocol(options.validProtocols)
    }
  }
  // 添加协议处理
  public _selectProtocol
  /**
   * 开始监听连接
   * @param {number} port
   * @param {string} [host]
   * @param {SocketCallBack} [callback] 将被添加为“connection”侦听器
   */
  public listen(port: number, host?: string, callback?: SocketCallBack) {
    if (typeof host === 'function') {
      callback = host
      host = undefined
    }
    if (callback) {
      this.on('listening', callback)
    }
    this.socket.listen(port, host, () => {
      this.emit('listening')
    })
    return this
  }
  /**
   * 停止服务器接受新连接并保留现有连接
   * 此函数是异步的，当所有连接结束时，服务器最终关闭，服务器发出“关闭”事件
   * “关闭”事件发生后，将调用回调。
   * @param {SocketCallBack} [callback]
   */
  public close(callback: SocketCallBack) {
    if (callback) this.once('close', callback)
    this.socket.close()
  }
  /**
   * 创建一个解析器，以选择服务器识别的客户端最喜欢的协议
   * @param {string[]} validProtocols
   * @returns {ServerProtocolCallback}
   */
  public _buildSelectProtocol(
    validProtocols: string[]
  ): ServerProtocolCallback {
    return function (_, protocols) {
      for (const protocol in protocols) {
        if (validProtocols.indexOf(protocol) !== -1) {
          // A valid protocol was found
          return protocol
        }
      }
      return undefined
    }
  }
}
