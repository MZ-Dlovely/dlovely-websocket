import net from 'net'
import tls from 'tls'
import { Server, ServerOptions } from './Server'
import { Connection, ConnectionOptions } from './Connect'
/**
 * 创建WebSocket服务器
 * @param {Object} [options] 将传递给net.createServer()或tls.createServer()并附加有'secure'(boolean)属性
 * @param {SocketCallBack} callback 将被添加到'connection'侦听器
 * @returns {Server}
 */
export function createServer(callback?: SocketCallBack): Server
export function createServer(options: object, callback?: SocketCallBack): Server
export function createServer(
  options?: ServerOptions | SocketCallBack,
  callback?: SocketCallBack
): Server {
  if (!arguments.length) return new Server(false)
  if (typeof options === 'function') return new Server(false, options)
  return new Server(Boolean(options?.secure), options, callback)
}

/**
 * 创建WebSocket客户端
 * @param {string} URL 以'ws://localhost:8000/chat'类型格式 (这个端口可以重复)
 * @param {Object} [options] 将传递给net.connect()或tls.connect()
 * @param {Function} callback 将被添加到'connect'侦听器
 * @returns {Connection}
 */
export function connect(URL: string, callback?: SocketCallBack): Connection
export function connect(
  URL: string,
  options: ConnectionOptions,
  callback?: SocketCallBack
): Connection
export function connect(
  URL: string,
  options?: ConnectionOptions | SocketCallBack,
  callback?: SocketCallBack
): Connection {
  if (typeof options === 'function') {
    callback = options
    options = undefined
  }
  options = options || ({} as ConnectionOptions)
  const connectionOptions: ConnectionOptions = parseWSURL(URL)
  options.port = connectionOptions.port
  options.host = connectionOptions.host
  connectionOptions.extraHeaders = options.extraHeaders
  connectionOptions.protocols = options.protocols
  let socket
  if (connectionOptions.secure) {
    socket = tls.connect(options)
  } else {
    socket = net.connect(options)
  }
  return new Connection(socket, connectionOptions, callback)
}

/**
 * 设置要在单个帧中发送的二进制数据包的最小大小
 * @param {number} bytes
 */
export function setBinaryFragmentation(bytes: number) {
  Connection.binaryFragmentation = bytes
}

/**
 * 设置内部缓冲区可以增长的最大大小，以避免内存攻击
 * @param {number} bytes
 */
export function setMaxBufferLength(bytes: number) {
  Connection.maxBufferLength = bytes
}

/**
 * 解析WebSocket url
 * @param {string} url
 * @returns {WSURL}
 * @private
 */
function parseWSURL(url: string): URL {
  const parts = new URL(url)
  parts.protocol = parts.protocol || 'ws:'
  let secure: boolean
  if (parts.protocol === 'ws:') {
    secure = false
  } else if (parts.protocol === 'wss:') {
    secure = true
  } else {
    throw new Error('无效协议: ' + parts.protocol + '. 协议必须为ws或wss')
  }
  parts.port = Number(parts.port || (secure ? 443 : 80))
  parts.pathname = parts.pathname || '/'
  return { ...parts, secure }
}
