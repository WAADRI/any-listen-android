import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'
import HistorySearch, { type HistorySearchType } from './HistorySearch'

interface BlankViewProps {
  onSearch: (keyword: string) => void
}
type Source = LX.OnlineSource | 'all'

export interface BlankViewType {
  show: (source: Source) => void
}

/**
 * 搜索页的空白态。
 *
 * 上游这里还有「热门搜索」（`HotSearch`），数据来自各商业音源的榜单接口；
 * any-listen 没有这个能力，`store/hotSearch` 里连一个源都注册不上，
 * 打开设置开关也只会是一片空白，故连同设置项一起删除。
 */
export default forwardRef<BlankViewType, BlankViewProps>(({ onSearch }, ref) => {
  const [visible, setVisible] = useState(false)
  const historySearchRef = useRef<HistorySearchType>(null)
  const isShowHistorySearch = useSettingValue('search.isShowHistorySearch')
  const t = useI18n()
  const theme = useTheme()

  const handleShow = (_source: Source) => {
    historySearchRef.current?.show()
  }

  useImperativeHandle(ref, () => ({
    show(source) {
      if (visible) handleShow(source)
      else {
        setVisible(true)
        requestAnimationFrame(() => {
          handleShow(source)
        })
      }
    },
  }), [visible])

  return (
    visible
      ? isShowHistorySearch
        ? (
            <ScrollView>
              <View style={styles.content}>
                <HistorySearch ref={historySearchRef} onSearch={onSearch} />
              </View>
            </ScrollView>
          )
        : (
            <View style={styles.welcome}>
              <Text size={22} color={theme['c-font-label']}>{t('search__welcome')}</Text>
            </View>
          )
      : null

  )
})


const styles = createStyle({
  content: {
    // paddingTop: 15,
    paddingBottom: 15,
    paddingLeft: 15,
    paddingRight: 15,
  },
  welcome: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
