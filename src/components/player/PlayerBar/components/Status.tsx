import { useAwlrc, useLrcPlay } from '@/plugins/lyric'
import { useIsPlay, useStatusText } from '@/store/player/hook'
// import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'
import { findAwlrcLine } from '@/utils/awlrc'
import { useWordLyricProgress } from '@/utils/hooks/useWordLyricProgress'
import { pickPlayBarText } from '../barText'


export default ({ autoUpdate }: { autoUpdate: boolean }) => {
  const theme = useTheme()
  const { line, text } = useLrcPlay(autoUpdate)
  const awlrc = useAwlrc()
  const statusText = useStatusText()
  const isPlay = useIsPlay()
  // console.log('render status')

  // 暂停时不能直接切成状态文字：它平时是空串，会让这一行整个消失。
  // 规则与理由见 `../barText.ts`。
  const status = pickPlayBarText(isPlay, text, statusText)
  // 只有「正在显示歌词」时才逐字上色：显示的是加载中/报错/播放结束这类状态文字时，
  // 那些字跟歌词没有对应关系（判据复用 pickPlayBarText，别再写第二套规则）
  const isLyricLine = pickPlayBarText(isPlay, '', statusText) === ''
  // 底栏拿不到行时间，只能按行号取；正文一致才用（见 findAwlrcLine）
  const awlrcLine = isLyricLine ? findAwlrcLine(awlrc, line, undefined, text) : undefined
  const { played } = useWordLyricProgress(awlrcLine)
  const segments = awlrcLine?.segments.length ? awlrcLine.segments : null

  return (
    <Text numberOfLines={1} size={12}>{
      segments
        ? segments.map((segment, index) => (
          <Text key={index} size={12} color={index < played ? theme['c-primary'] : undefined}>{segment.text}</Text>
        ))
        : status
    }</Text>
  )
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
