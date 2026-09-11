/**
 * 兜住设置页里本 fork 新增的界面，避免它把整个设置页拖成白屏。
 *
 * ## 为什么需要它
 *
 * 白屏是这类崩溃唯一的表现：我的服务器配置界面一旦在渲染中抛错，
 * React 会卸载整棵子树，用户看到的是一片空白，**没有任何提示**，
 * 也就无从反馈 —— 只能截图，而截图里没有异常类型、没有组件栈。
 *
 * 把这块界面单独包进错误边界后，崩溃会被就地拦住并显示错误原文，
 * 设置页其余部分照常可用。这样：
 *
 * - 用户能看到到底哪一行出了问题，并直接复制出来；
 * - 即使这个界面坏了，用户仍能进入「设置 → 其他 → 错误日志」把日志取出来。
 *
 * 这是上游没有的组件。上游没有这个问题，因为它不为「本 fork 自己写的
 * 一块可能崩的界面」负责；而这里必须负责，否则一次崩溃就会让人完全失去
 * 配置服务器的入口。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { View } from 'react-native'

import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import { clipboardWriteText, createStyle, toast } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { log } from '@/utils/log'

interface Props {
  /** 出错时显示的标题，便于用户知道是哪一块坏了。 */
  title: string
  children: ReactNode
}

interface State {
  error: Error | null
}

/** 用函数组件渲染错误内容，以便能用主题。 */
const ErrorView = ({ title, error }: { title: string, error: Error }) => {
  const theme = useTheme()
  const detail = `${title}\n${error.name}: ${error.message}\n\n${error.stack ?? ''}`
  return (
    <View style={styles.container}>
      <Text size={13} color={theme['c-primary-font']}>{title}</Text>
      <Text size={12} style={styles.message}>
        {error.name}: {error.message}
      </Text>
      {error.stack ? (
        <Text size={11} style={styles.stack} color={theme['c-font-label']}>{error.stack}</Text>
      ) : null}
      {/* 与崩溃弹窗一致：RN 的文本默认不可选中，必须给一个复制入口，
          否则用户只能截图，而截图里没法搜索、也常常截不全。 */}
      <Button onPress={() => {
        clipboardWriteText(detail)
        toast('已复制')
      }}>
        <Text size={12} color={theme['c-button-font']}>复制错误信息</Text>
      </Button>
      <Text size={11} style={styles.hint} color={theme['c-font-label']}>
        也可以到「设置 → 其他 → 错误日志」查看完整日志。
      </Text>
    </View>
  )
}

export default class SettingsErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 同时落到应用日志里，便于事后从「错误日志」取出
    log.error(`[settings] ${this.props.title} 渲染失败: ${error.stack ?? error.message}`)
    if (info.componentStack) log.error(`[settings] componentStack: ${info.componentStack}`)
  }

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorView title={this.props.title} error={this.state.error} />
    }
    return this.props.children
  }
}

const styles = createStyle({
  container: {
    paddingLeft: 25,
    paddingRight: 25,
    marginBottom: 18,
  },
  message: {
    marginTop: 6,
    marginBottom: 6,
    lineHeight: 17,
  },
  stack: {
    marginBottom: 8,
    lineHeight: 15,
  },
  hint: {
    lineHeight: 16,
  },
})
