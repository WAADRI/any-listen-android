import { useRef, useImperativeHandle, forwardRef, useState, useEffect } from 'react'
import SearchTipList, { type SearchTipListProps as _SearchTipListProps, type SearchTipListType as _SearchTipListType } from '@/components/SearchTipList'
import Button from '@/components/common/Button'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { scaleSizeH } from '@/utils/pixelRatio'
import musicSdk from '@/utils/musicSdk'
import searchState, { type InitState as SearchState } from '@/store/search/state'
import { setSearchText, setTipList, setTipListInfo } from '@/core/search/search'
import { debounce } from '@/utils'

export const ITEM_HEIGHT = scaleSizeH(36)

export const debounceTipSearch = debounce((keyword: string, source: SearchState['temp_source'], callback: (list: string[]) => void) => {
  /**
   * 联想是**可选能力**：音源可以不提供 `tipSearch`（本 fork 的 anylisten
   * 只在曲库就绪后才给候选词，`'all'` 更是根本没有这个对象）。
   *
   * 上游这里写的是 `musicSdk[source].tipSearch.search(keyword)`，任何一处缺失
   * 都会在**每次按键**后抛 `TypeError: Cannot read property 'search' of undefined`
   * —— 用户在搜索框里打字就一直弹错误。
   *
   * 所以缺能力就当没有候选词：不报错、不外抛，把 `.then(callback)` 也一起
   * 收进 try，避免 promise 链上的 rejection 变成未处理异常。
   */
  void Promise.resolve()
    .then(() => musicSdk[source]?.tipSearch?.search?.(keyword) ?? [])
    .then(callback)
    .catch((err: unknown) => {
      console.warn('[search] 联想词获取失败：', err instanceof Error ? err.message : String(err))
      callback([])
    })
}, 200)


export type SearchTipListProps = _SearchTipListProps<string>
export type SearchTipListType = _SearchTipListType<string>

interface TipListProps {
  onSearch: (keyword: string) => void
}
export interface TipListType {
  search: (keyword: string, height: number) => void
  show: (height: number) => void
  hide: () => void
}

export default forwardRef<TipListType, TipListProps>(({ onSearch }, ref) => {
  const searchTipListRef = useRef<SearchTipListType>(null)
  const [visible, setVisible] = useState(false)
  const visibleListRef = useRef(false)
  const isUnmountedRef = useRef(false)

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  const handleSearch = (keyword: string, height: number) => {
    searchTipListRef.current?.setHeight(height)
    setSearchText(keyword)
    if (keyword) {
      setTipListInfo(keyword, searchState.temp_source)
      debounceTipSearch(keyword, searchState.temp_source, (list) => {
        if (keyword != searchState.tipListInfo.text) return
        setTipList(list)
        if (!visibleListRef.current || isUnmountedRef.current) return
        searchTipListRef.current?.setList(list)
      })
    } else {
      setTipListInfo(keyword, searchState.temp_source)
      setTipList([])
      searchTipListRef.current?.setList([])
    }
  }

  const handleShowList = (height: number) => {
    searchTipListRef.current?.setHeight(height)
    if (searchState.tipListInfo.list.length) {
      visibleListRef.current = true
      searchTipListRef.current?.setList([...searchState.tipListInfo.list])
    }
  }

  useImperativeHandle(ref, () => ({
    search(keyword, height) {
      if (visible) handleSearch(keyword, height)
      else {
        setVisible(true)
        requestAnimationFrame(() => {
          handleSearch(keyword, height)
        })
      }
    },
    show(height) {
      visibleListRef.current = true
      if (visible) handleShowList(height)
      else {
        setVisible(true)
        requestAnimationFrame(() => {
          handleShowList(height)
        })
      }
    },
    hide() {
      requestAnimationFrame(() => {
        visibleListRef.current = false
        searchTipListRef.current?.setList([])
      })
    },
  }), [visible])

  const renderItem: SearchTipListProps['renderItem'] = ({ item, index }) => {
    return (
      <Button style={styles.item} onPress={() => { onSearch(item) }} key={index}>
        <Text numberOfLines={1}>{item}</Text>
      </Button>
    )
  }
  const getkey: SearchTipListProps['keyExtractor'] = (item, index) => String(index)
  const getItemLayout: SearchTipListProps['getItemLayout'] = (data, index) => {
    return { length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index }
  }

  return (
    visible
      ? <SearchTipList
          ref={searchTipListRef}
          renderItem={renderItem}
          onPressBg={() => searchTipListRef.current?.setList([])}
          keyExtractor={getkey}
          getItemLayout={getItemLayout}
        />
      : null
  )
})


const styles = createStyle({
  item: {
    height: ITEM_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 15,
    paddingRight: 15,
    // backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
})

