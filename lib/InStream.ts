import stream from 'stream'

/**
 * 表示二进制帧的可读流
 */
export class InStream extends stream.Readable {
  /**
   * 这里没有逻辑，push是在外面进行的
   */
  public _read = () => {}
  /**
   * 向流中添加更多数据并触发“可读”事件
   * @param {Buffer} data
   */
  public addData = (data: Buffer) => {
    this.push(data)
  }
  /**
   * 当没有更多数据要添加到流中时
   */
  public end = () => {
    this.push(null)
  }
}
