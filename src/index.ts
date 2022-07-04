import { SocketApp } from './SocketApp'
export { SocketApp }
export const createServerApp = (options?: SocketApp.Options) =>
  options
    ? new SocketApp(
        Boolean(options?.secure),
        options
      )
    : new SocketApp(false)
