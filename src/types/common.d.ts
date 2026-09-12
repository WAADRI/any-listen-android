// import './app_setting'

declare namespace LX {
  /**
   * 在线音源标识。
   *
   * 这是**字面量联合**而不是 `string`，所以新增一个源必须在这里加名字，
   * 否则所有 `musicSdk[x as LX.OnlineSource]`、`Partial<Record<LX.OnlineSource, …>>`
   * 都会类型报错。
   *
   * `anylisten` 指向用户自建的 any-listen 服务器，是本 fork 唯一的音源。
   */
  type OnlineSource = 'kw' | 'kg' | 'tx' | 'wy' | 'mg' | 'anylisten'
  type Source = OnlineSource | 'local'
  type Quality = '128k' | '320k' | 'flac' | 'flac24bit' | '192k' | 'ape' | 'wav'
  type QualityList = Partial<Record<LX.Source, LX.Quality[]>>

  type ShareType = 'system' | 'clipboard'

  type UpdateStatus = 'downloaded' | 'downloading' | 'error' | 'checking' | 'idle'
  interface VersionInfo {
    version: string
    desc: string
  }
}
