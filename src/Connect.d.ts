export {}
export declare class Connection {
  on(event: string, listener: (...args: any[]) => void): this
  on(event: 'close', listener: (code: number, reason?: string) => void): this
  on(event: 'connect', listener: (conn: Connection) => void): this
  on(event: 'error', listener: (code: number, reason?: string) => void): this
  on(event: 'text', listener: (str: string) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  once(event: 'close', listener: (code: number, reason?: string) => void): this
  once(event: 'connect', listener: (conn: Connection) => void): this
  once(event: 'error', listener: (code: number, reason?: string) => void): this
  once(event: 'text', listener: (str: string) => void): this
}
