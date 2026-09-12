import { useLrcPlay } from '@/plugins/lyric'
import { useIsPlay, useStatusText } from '@/store/player/hook'
// import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { pickPlayBarText } from '../barText'


export default ({ autoUpdate }: { autoUpdate: boolean }) => {
  const { text } = useLrcPlay(autoUpdate)
  const statusText = useStatusText()
  const isPlay = useIsPlay()
  // console.log('render status')

  // 暂停时不能直接切成状态文字：它平时是空串，会让这一行整个消失。
  // 规则与理由见 `../barText.ts`。
  const status = pickPlayBarText(isPlay, text, statusText)

  return <Text numberOfLines={1} size={12}>{status}</Text>
}

// const styles = createStyle({
//   text: {
//     // fontSize: 10,
//     // lineHeight: 18,
//     // height: 18,
//     // height: '100%',
//     // backgroundColor: 'rgba(0,0,0,0.2)',
//   },
// })
