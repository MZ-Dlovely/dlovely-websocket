/// <reference types="@types/node/http" />
/// <reference types="@types/node/net" />
/// <reference types="@types/node/tls" />
/// <reference types="@types/node/events" />
/// <reference types="@types/node/crypto" />
/// <reference types="@types/node/buffer" />
/// <reference types="@types/node/stream" />

export interface SocketCallBack {
  (err?: Error): void
}
