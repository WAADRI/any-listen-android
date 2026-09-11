import { memo } from 'react'

import Theme from '../Theme'
import Section from '../../components/Section'
import Server from './Server'
import Language from './Language'
import FontSize from './FontSize'
import ShareType from './ShareType'
import IsStartupAutoPlay from './IsStartupAutoPlay'
import IsStartupPushPlayDetailScreen from './IsStartupPushPlayDetailScreen'
import IsAutoHidePlayBar from './IsAutoHidePlayBar'
import IsHomePageScroll from './IsHomePageScroll'
import IsAllowProgressBarSeek from './IsAllowProgressBarSeek'
import IsUseSystemFileSelector from './IsUseSystemFileSelector'
import IsAlwaysKeepStatusbarHeight from './IsAlwaysKeepStatusbarHeight'
import IsShowBackBtn from './IsShowBackBtn'
import IsShowExitBtn from './IsShowExitBtn'
import DrawerLayoutPosition from './DrawerLayoutPosition'
import { useI18n } from '@/lang/i18n'

export default memo(() => {
  const t = useI18n()


  return (
    <Section title={t('setting_basic')}>
      {/* 本 fork 的曲库全部来自自建服务器，所以服务器配置是这里最重要的一项，
          放在最前面。上游的「音源选择」「音源名称显示」两项已移除：
          音源不再可切换，也不存在别名/原名之分。 */}
      <Server />
      <IsStartupAutoPlay />
      <IsStartupPushPlayDetailScreen />
      <IsShowBackBtn />
      <IsShowExitBtn />
      <IsAutoHidePlayBar />
      <IsHomePageScroll />
      <IsAllowProgressBarSeek />
      <IsUseSystemFileSelector />
      <IsAlwaysKeepStatusbarHeight />
      <Theme />
      <DrawerLayoutPosition />
      <Language />
      <FontSize />
      <ShareType />
    </Section>
  )
})
