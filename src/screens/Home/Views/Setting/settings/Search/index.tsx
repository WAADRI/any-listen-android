import { memo } from 'react'

import Section from '../../components/Section'
import IsShowHistorySearch from './IsShowHistorySearch'

import { useI18n } from '@/lang'

export default memo(() => {
  const t = useI18n()

  return (
    <Section title={t('setting_search')}>
      {/* 「显示热门搜索」已删除：热门搜索由各商业音源的榜单接口支撑，
          any-listen 没有这个能力，打开开关也只会是一片空白。 */}
      <IsShowHistorySearch />
    </Section>
  )
})
