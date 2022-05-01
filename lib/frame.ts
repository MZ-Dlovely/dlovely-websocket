/**
 * 创建文本帧
 * @param {string} data
 * @param {boolean} [masked=false] if the frame should be masked
 * @returns {Buffer}
 */
export function createTextFrame(data: string, masked: boolean = false): Buffer {
  const payload = Buffer.from(data)
  const meta = generateMetaData(true, 1, masked, payload)
  return Buffer.concat([meta, payload], meta.length + payload.length)
}

/**
 * 创建二进制帧
 * @param {Buffer} data
 * @param {boolean} [masked=false] if the frame should be masked
 * @param {boolean} [first=true] if this is the first frame in a sequence
 * @param {boolean} [fin=true] if this is the final frame in a sequence
 * @returns {Buffer}
 */
export function createBinaryFrame(
  data: Buffer,
  masked: boolean = false,
  first: boolean = true,
  fin: boolean = true
): Buffer {
  let payload
  if (masked) {
    payload = Buffer.alloc(data.length)
    data.copy(payload)
  } else payload = data
  const meta = generateMetaData(fin, first ? 2 : 0, masked, payload)
  return Buffer.concat([meta, payload], meta.length + payload.length)
}

/**
 * 创建关闭帧
 * @param {number} code
 * @param {string} [reason='']
 * @param {boolean} [masked=false] if the frame should be masked
 * @returns {Buffer}
 */
export function createCloseFrame(
  code: number,
  reason: string = '',
  masked: boolean = false
): Buffer {
  let payload
  if (code && code !== 1005) {
    payload = Buffer.from(`--${reason}`)
    payload.writeUInt16BE(code, 0)
  } else {
    payload = Buffer.alloc(0)
  }
  const meta = generateMetaData(true, 8, masked, payload)
  return Buffer.concat([meta, payload], meta.length + payload.length)
}

/**
 * 创建Ping帧
 * @param {string} data
 * @param {boolean} [masked=false] if the frame should be masked
 * @returns {Buffer}
 */
export function createPingFrame(data: string, masked: boolean = false): Buffer {
  const payload = Buffer.from(data)
  const meta = generateMetaData(true, 9, masked, payload)
  return Buffer.concat([meta, payload], meta.length + payload.length)
}

/**
 * 创建Pong帧
 * @param {string} data
 * @param {boolean} [masked=false] if the frame should be masked
 * @returns {Buffer}
 */
export function createPongFrame(data: string, masked: boolean = false): Buffer {
  const payload = Buffer.from(data)
  const meta = generateMetaData(true, 10, masked, payload)
  return Buffer.concat([meta, payload], meta.length + payload.length)
}

/**
 * 创建`frame`中的`meta-data`
 * 如果`frame`被屏蔽，`payload`将相应地改变
 * @param {boolean} fin
 * @param {number} opcode
 * @param {boolean} masked
 * @param {Buffer} payload 负载
 * @returns {Buffer}
 */
function generateMetaData(
  fin: boolean,
  opcode: number,
  masked: boolean,
  payload: Buffer
): Buffer {
  const len = payload.length
  // 为`meta-data`创建缓冲区
  const meta = Buffer.alloc(
    2 + (len < 126 ? 0 : len < 65536 ? 2 : 8) + (masked ? 4 : 0)
  )
  // 设置`fin`和`opcode`
  meta[0] = (fin ? 128 : 0) + opcode
  // 设置`mask`and长度
  meta[1] = masked ? 128 : 0
  let start = 2
  if (len < 126) {
    meta[1] += len
  } else if (len < 65536) {
    meta[1] += 126
    meta.writeUInt16BE(len, 2)
    start += 2
  } else {
    // 警告：JS不支持大于2^53的整数
    meta[1] += 127
    meta.writeUInt32BE(Math.floor(len / Math.pow(2, 32)), 2)
    meta.writeUInt32BE(len % Math.pow(2, 32), 6)
    start += 8
  }
  // 设置`mask-key`
  if (masked) {
    const mask = Buffer.alloc(4)
    for (let i = 0; i < 4; i++) {
      meta[start + i] = mask[i] = Math.floor(Math.random() * 256)
    }
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4]
    }
    start += 4
  }
  return meta
}
