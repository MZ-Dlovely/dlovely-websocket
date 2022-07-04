import { EventEmitter } from 'events'
import net from 'net'
import tls from 'tls'
import { randomString, createToast } from './common'
import { AppConnection } from './SocketConnect'

export declare namespace SocketApp {
  interface ProtocolCallback {
    (conn: AppConnection, protocols?: string[]): string | undefined
  }
  type Options = tls.TlsOptions & {
    secure?: boolean
    debugger?: boolean
  } & ({ selectProtocol: ProtocolCallback } | { validProtocols: string[] } | {})
  type ConnectCallback<Data = any> = (
    data: Data,
    conn: AppConnection,
    next: () => void
  ) => void
}

export class SocketApp extends EventEmitter {
  private readonly socket
  readonly connections = new Map<string, AppConnection>()
  private readonly toast
  constructor(secure: boolean, options?: SocketApp.Options) {
    super()
    this.toast = createToast('SocketApp', options?.debugger)

    const onConnection = (socket: net.Socket | tls.TLSSocket) => {
      let token = randomString(8)
      const conn = new AppConnection(
        token,
        socket,
        this,
        options?.debugger || false,
        () => {
          while (this.connections.has(token)) {
            token = randomString(8)
          }
          this.toast.log(`接收到连接：`, token)
          this.connections.set(token, conn)
          this.emit('connection', token, conn)
        }
      )
      conn.on('close', () => {
        this.toast.warn(`连接关闭：`, token)
        this.connections.delete(token)
      })
      conn.on('error', err => {
        this.toast.error(`连接错误，已自动断开：`, token, '\r\n', err)
        this.connections.delete(token)
      })
    }
    this.socket =
      secure && options
        ? tls.createServer(options, onConnection)
        : net.createServer(options, onConnection)
    this.socket.on('close', () => this.emit('close'))
    this.socket.on('error', err => this.emit('error', err))
    this.on('connection', (token: string, conn: AppConnection) => {
      conn.on('text', str => {
        try {
          const { sign, data } = JSON.parse(str)
          this.toast.log(
            `连接[${token}]传入：${sign}${
              data
                ? typeof data === 'string'
                  ? `\t${data}`
                  : Object.entries(data)
                      .map(val => `${val[0]}:\t|${val[1]}`)
                      .join('\r\n')
                : ''
            }`
          )
          const cbs = this.signs.get(sign) || this.signs.get('unknow')
          if (!cbs || !Array.isArray(cbs)) return
          let i = -1
          const next = () => {
            i++
            if (i < cbs.length) cbs[i](data, conn, next)
          }
          next()
        } catch (e) {
          this.toast.log(`连接[${token}]传入：noJSON\t${str}`)
          const cbs = this.signs.get('noJSON')
          if (!cbs) return
          let i = -1
          const next = () => {
            i++
            if (i < cbs.length) cbs[i](str, conn, next)
          }
          next()
        }
      })
    })
    if (!options) {
    } else if ('selectProtocol' in options) {
      // 用户提供的逻辑
      this._selectProtocol = options.selectProtocol
    } else if ('validProtocols' in options) {
      // 默认逻辑
      this._selectProtocol = (_, protocols) => {
        for (const protocol in protocols) {
          if (options.validProtocols.indexOf(protocol) !== -1) return protocol
        }
        return undefined
      }
    }
  }
  _selectProtocol?: SocketApp.ProtocolCallback

  /**
   * 开始监听连接
   * @param {number} port
   * @param {string} [host]
   * @param {Function} [callback] 将被添加为“connection”侦听器
   */
  public listen(port: number, callback?: () => void): void
  public listen(port: number, host: string, callback?: () => void): void
  public listen(
    port: number,
    host?: string | (() => void),
    callback?: () => void
  ) {
    if (typeof host === 'function') {
      callback = host
      host = undefined
    }
    if (callback) this.on('listening', callback)
    this.socket.listen(port, host, () => {
      this.emit('listening')
      this.toast.log(`开始监听${host ? `${host}:` : ''}${port}`)
    })
    return this
  }
  /**
   * 停止服务器接受新连接并保留现有连接
   * 此函数是异步的，当所有连接结束时，服务器最终关闭，服务器发出“关闭”事件
   * “关闭”事件发生后，将调用回调。
   * @param {Function} [callback]
   */
  public close(callback?: () => void) {
    this.once('close', () => this.toast.warn('连接关闭'))
    if (callback) this.once('close', callback)
    this.socket.close()
  }

  private signs = new Map<string, SocketApp.ConnectCallback[]>()
  /**
   * sign
   */
  public sign<Data = any>(
    sign: string,
    ...callback: SocketApp.ConnectCallback<Data>[]
  ) {
    this.signs.set(sign, this.signs.get(sign)?.concat(...callback) || callback)
    return this
  }
}
