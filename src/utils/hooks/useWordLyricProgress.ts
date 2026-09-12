import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { getPosition } from '@/plugins/player'
import playerState from '@/store/player/state'
import { playedCount, type AwlrcLine } from '@/utils/awlrc'

/**
 * 逐字歌词的刷新间隔。
 *
 * 1s 的进度定时器（`core/init/player/playProgress.ts`）对进度条够用，
 * 但对逐字上色太粗；100ms 是本机轮询位置的下限（约每字一次），
 * 再快也只是徒增桥接调用。
 */
const POLL_INTERVAL = 100

/**
 * 算出当前行已经唱到第几段，用于逐字歌词上色。
 *
 * 只在**当前行有逐字信息**时才轮询播放位置：其余情况直接返回 0，不装定时器，
 * 所以整屏几十行里实际只有一行在做 100ms 轮询。
 *
 * 位置有三种来源，缺一不可：
 * 1. 播放中 —— 100ms 定时器读本机播放位置（进度是本地的，服务端不参与）；
 * 2. 切行/换歌 —— effect 重跑时立即对齐一次，不必等下一个 tick；
 * 3. 拖动进度条、恢复播放进度 —— `setProgress` 事件，此时播放位置不是定时器给的
 *    （暂停时拖动尤其明显：定时器已经停了，只能靠事件）。
 *
 * @param line 当前行在逐字歌词里的对应行（没有逐字信息时传 undefined）
 * @returns 已唱段数，`index < played` 的段用已唱色
 */
export const useWordLyricProgress = (line: AwlrcLine | undefined): number => {
  const [played, setPlayed] = useState(0)

  useEffect(() => {
    const segments = line?.segments
    const lineTimeMs = line?.timeMs
    if (!segments?.length || lineTimeMs == null) {
      setPlayed(0)
      return
    }

    let isUnmounted = false
    // 段的时间是相对本行起始的，所以要减去行时间
    const apply = (positionMs: number) => {
      if (isUnmounted) return
      setPlayed(playedCount(segments, positionMs - lineTimeMs))
    }
    const readPosition = () => {
      void getPosition().then((position) => {
        apply(position * 1000)
      }).catch(() => {})
    }

    readPosition()
    const timer = setInterval(() => {
      // 界面看不见的时候不轮询：后台时这一层没人看，白唤醒 10 次/秒
      if (!playerState.isPlay || AppState.currentState === 'background') return
      readPosition()
    }, POLL_INTERVAL)

    const handleSetProgress = (time: number) => {
      apply(time * 1000)
    }
    global.app_event.on('setProgress', handleSetProgress)

    return () => {
      isUnmounted = true
      clearInterval(timer)
      global.app_event.off('setProgress', handleSetProgress)
    }
  }, [line])

  return played
}

export default useWordLyricProgress
