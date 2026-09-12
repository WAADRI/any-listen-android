import { readMetadata } from '@/utils/localMediaMetadata'
import { handleImportList } from '@/screens/Home/Views/Setting/settings/Backup/actions'
import { type FileType, readFile } from '@/utils/fs'
import { confirmDialog, toast } from '@/utils/tools'
import { importUserApi } from '@/core/userApi'
import { log } from '@/utils/log'
import playerState from '@/store/player/state'
import { addTempPlayList } from '@/core/player/tempPlayList'
import { LIST_IDS } from '@/config/constant'
import { playNext } from '@/core/player/player'
import { buildLocalMusicInfo, buildLocalMusicInfoByFilePath } from '@/screens/Home/Views/Mylist/MyList/listAction'


export const handleFileLXMCAction = async(file: FileType) => {
  if (!(await confirmDialog({
    message: global.i18n.t('deep_link_file_lxmc_confirm_tip', { name: file.name }),
  }))) return

  handleImportList(file.path)
}

export const handleFileMusicAction = async(file: FileType) => {
  const info = await readMetadata(file.path)
  const isPlaying = !!playerState.playMusicInfo.musicInfo
  const musicInfo = info ? buildLocalMusicInfo(file.path, info) : buildLocalMusicInfoByFilePath(file)
  console.log(musicInfo)
  addTempPlayList([{ listId: LIST_IDS.PLAY_LATER, musicInfo, isTop: true }])
  if (isPlaying) void playNext()
}

/**
 * 导入外部传入的「自定义源脚本」（.js 文件）。
 *
 * 逻辑原先在 `Setting/settings/Basic/UserApiEditModal/action.ts` 里，而那个
 * 目录只剩这个函数还在被使用（弹窗本身随「自定义源管理」界面一起删除了，
 * 它引用的 `musicSdk/api-source-info` 也早已不存在），因此直接搬进来。
 */
export const handleFileJSAction = async(file: FileType) => {
  if (!(await confirmDialog({
    message: global.i18n.t('deep_link_file_js_confirm_tip', { name: file.name }),
  }))) return

  void readFile(file.path).then(async(script) => {
    if (script == null) throw new Error('Read file failed')
    await importUserApi(script)
    toast(global.i18n.t('user_api_import_success_tip'))
  }).catch((error: any) => {
    log.error(error.stack)
    toast(global.i18n.t('user_api_import_failed_tip', { message: error.message }), 'long')
  })
}
