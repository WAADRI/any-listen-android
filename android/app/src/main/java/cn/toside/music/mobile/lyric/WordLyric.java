package cn.toside.music.mobile.lyric;

import java.util.List;

/**
 * 桌面歌词的逐字（卡拉OK）数据与其时间轴。
 *
 * ## 数据从哪来
 *
 * 服务端的 `awlyric` 由 JS 侧解析（`src/utils/awlrc.ts`，有单测 + 真实数据），
 * 再通过 `LyricModule.setLyric(...)` 以嵌套数组的形式传进来：
 *
 * ```
 * [ [time, [ [start, duration, text], ... ] ], ... ]
 * ```
 *
 * 解码在 `LyricModule.parseWordLines`，这里只放**纯逻辑**（没有 Android 依赖），
 * 方便以后加 JVM 单测。
 *
 * ## 时间轴语义（与 JS / 桌面版一致）
 *
 * 段的 `start` / `duration` 都是**相对本行起始**的毫秒；段与段之间的空隙保持不动；
 * 时长为 0 的段（实测是标点）到点即整段算唱完。
 */
public final class WordLyric {
  /** 一个字/词段。`start`/`duration` 相对本行起始。 */
  public static final class Segment {
    public final int start;
    public final int duration;
    public final String text;

    public Segment(int start, int duration, String text) {
      this.start = start;
      this.duration = duration;
      this.text = text == null ? "" : text;
    }
  }

  /** 逐字歌词里的一行。`time` 是该行的绝对时间（毫秒）。 */
  public static final class Line {
    public final int time;
    public final String text;
    public final List<Segment> segments;

    public Line(int time, String text, List<Segment> segments) {
      this.time = time;
      this.text = text == null ? "" : text;
      this.segments = segments;
    }
  }

  private WordLyric() {}

  /**
   * 到 `elapsedMs`（相对本行起始）为止，唱到了**第几个字**。
   *
   * 返回的是「字符位置」而不是像素：`3.4` 表示前 3 个字唱完、第 4 个字唱了 40%。
   * 用字符位置而不是像素，是为了让自绘控件按**真实排版**（可能折行）去取坐标，
   * 不必自己累加每段宽度。
   */
  public static float charPositionAt(List<Segment> segments, int elapsedMs) {
    if (segments == null || segments.isEmpty()) return 0f;
    float chars = 0f;
    for (Segment segment : segments) {
      int length = segment.text.length();
      if (elapsedMs < segment.start) return chars;
      if (segment.duration <= 0 || elapsedMs >= segment.start + segment.duration) {
        chars += length;
        continue;
      }
      float progress = (elapsedMs - segment.start) / (float) segment.duration;
      return chars + length * progress;
    }
    return chars;
  }

  private static boolean sameText(String a, String b) {
    if (a == null) a = "";
    if (b == null) b = "";
    return a.trim().equals(b.trim());
  }

  /**
   * 取当前行对应的逐字段。
   *
   * 原生播放器自己解析 `lrc`（行序、去重规则与 JS 侧不完全一致），所以先按**行时间**
   * 精确匹配，再按行号兜底，并且**要求正文一致**——错位时宁可整行上色，也不能把
   * 别的行的字按这一行的时间扫出来。
   */
  public static Line findLine(List<Line> lines, int lineIndex, int lineTime, String text) {
    if (lines == null || lines.isEmpty()) return null;
    for (Line line : lines) {
      if (line.time == lineTime && sameText(line.text, text)) return line;
    }
    if (lineIndex >= 0 && lineIndex < lines.size()) {
      Line line = lines.get(lineIndex);
      if (sameText(line.text, text)) return line;
    }
    return null;
  }
}
