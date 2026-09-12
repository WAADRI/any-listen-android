package cn.toside.music.mobile.lyric;

import java.util.List;

/**
 * 支持逐字扫光的桌面歌词文字控件（单行与多行两种实现）。
 *
 * `LyricSwitchView` 只通过这个接口操作它们，不必关心具体是哪种模式。
 */
public interface WordLyricView {
  /** 未唱到的字用这个颜色 */
  void setUnplayColor(int color);

  /** 已唱到的字用这个颜色 */
  void setPlayedColor(int color);

  /**
   * 设置当前行的逐字信息。
   *
   * @param segments 段（时间相对本行起始）；null 表示这一行没有逐字信息
   * @param lineTime 该行的绝对时间（毫秒）
   * @param player   用于取播放位置（本机时钟）
   */
  void setWordLyric(List<WordLyric.Segment> segments, int lineTime, LyricPlayer player);

  /** 只更新取播放位置用的播放器（悬浮窗创建/重建时用），不动逐字数据 */
  void setPlayer(LyricPlayer player);

  /** 播放/暂停切换后让扫光重新动起来（暂停时扫光会冻在当前进度） */
  void invalidateWordSweep();
}
