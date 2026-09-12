package cn.toside.music.mobile.lyric;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.text.Layout;
import android.text.TextPaint;
import android.view.Gravity;
import android.widget.TextView;

import java.util.List;

/**
 * 多行桌面歌词（默认模式）的自绘控件 —— 逐字扫光。
 *
 * ## 为什么要自绘
 *
 * 上游多行模式用的是普通 `TextView`，而 `TextView` 的文字由框架在 `super.onDraw` 里
 * 一次画完，外部**没法只画「已唱到的那一部分」**（RN 那边可以用一个会长的裁剪盒，
 * Android 这边必须自己拿 `Layout` 画）。
 *
 * 做法与 RN / 桌面版一致：把同一段文字画两遍——先整段用**未唱色**画，再用**已唱色**
 * 画，但只画到「已唱位置」为止（用 `clipRect` 裁）。两遍文字来自**同一个 `Layout`**，
 * 位置完全一致，边界是硬切，就是逐字扫过的效果。
 *
 * ## 位置怎么算
 *
 * 排版直接用框架排好的 {@link TextView#getLayout()}：它已经按字号/宽度/maxLines/
 * ellipsize 排好版，`getPrimaryHorizontal` 拿到的就是屏幕上的真实坐标，所以**折行的行
 * 也能正确扫**（第 1 行扫完接着扫第 2 行），不用自己累加每段宽度，也不用自己建
 * `StaticLayout`（那几个带 `TruncateAt` 的旧构造器在 compileSdk 36 上已经不可用了）。
 */
@SuppressLint("AppCompatCustomView")
public class LyricMultilineTextView extends TextView implements WordLyricView {
  /** 扫光刷新间隔，约 60fps；只在播放中且这一行还没唱完时才排下一次 */
  private static final int WORD_INVALIDATE_DELAY = 16;

  private int unplayColor;
  private int playedColor;
  private List<WordLyric.Segment> wordSegments = null;
  private int wordLineTime = 0;
  private LyricPlayer player = null;

  private final Runnable invalidateRunnable = this::invalidate;

  public LyricMultilineTextView(Context context) {
    super(context);
    unplayColor = getCurrentTextColor();
    playedColor = unplayColor;
  }

  @Override
  public void setUnplayColor(int color) {
    unplayColor = color;
    postInvalidate();
  }

  @Override
  public void setPlayedColor(int color) {
    playedColor = color;
    postInvalidate();
  }

  /** `LyricSwitchView.setTextColor` / `LyricView.setColor` 走的是这条路 */
  @Override
  public void setTextColor(int color) {
    playedColor = color;
    postInvalidate();
  }

  @Override
  public void setWordLyric(List<WordLyric.Segment> segments, int lineTime, LyricPlayer player) {
    wordSegments = segments;
    wordLineTime = lineTime;
    this.player = player;
    postInvalidate();
  }

  @Override
  public void setPlayer(LyricPlayer player) {
    this.player = player;
    postInvalidate();
  }

  @Override
  public void invalidateWordSweep() {
    postInvalidate();
  }

  private float getDrawY(int layoutHeight) {
    int contentHeight = getHeight() - getPaddingTop() - getPaddingBottom();
    int vertical = getGravity() & Gravity.VERTICAL_GRAVITY_MASK;
    if (vertical == Gravity.CENTER_VERTICAL) return getPaddingTop() + (contentHeight - layoutHeight) / 2f;
    if (vertical == Gravity.BOTTOM) return getPaddingTop() + contentHeight - layoutHeight;
    return getPaddingTop();
  }

  /** 歌词部分的长度（翻译是 `LyricView` 用 `\n` 接在后面的） */
  private int getLyricLength() {
    CharSequence text = getText();
    if (text == null) return 0;
    int index = text.toString().indexOf('\n');
    return index < 0 ? text.length() : index;
  }

  /** 当前已唱到的字符位置；返回 -1 表示这一行没有逐字信息（整行用已唱色画） */
  private float getSweptCharPosition() {
    if (wordSegments == null || wordSegments.isEmpty() || player == null || !player.hasPlayed()) return -1f;
    return WordLyric.charPositionAt(wordSegments, player.getCurrentTimeMs() - wordLineTime);
  }

  private void drawSwept(Canvas canvas, Layout layout, float charPosition) {
    CharSequence text = getText();
    if (text == null) return;
    int length = text.length();
    int lyricLength = getLyricLength();
    int offset = (int) charPosition;
    float fraction = charPosition - offset;
    if (offset > lyricLength) {
      offset = lyricLength;
      fraction = 0f;
    }
    int safeOffset = Math.min(offset, length);
    int row = layout.getLineForOffset(safeOffset);
    float startX = layout.getPrimaryHorizontal(safeOffset);
    float endX = offset + 1 <= length ? layout.getPrimaryHorizontal(offset + 1) : layout.getLineRight(row);
    float sweepX = startX + (endX - startX) * fraction;

    // ① 已唱完的整行
    if (row > 0) {
      canvas.save();
      canvas.clipRect(0f, layout.getLineTop(0), layout.getWidth(), layout.getLineBottom(row - 1));
      layout.draw(canvas);
      canvas.restore();
    }
    // ② 正在唱的这一行：只画到扫过位置
    canvas.save();
    canvas.clipRect(0f, layout.getLineTop(row), sweepX, layout.getLineBottom(row));
    layout.draw(canvas);
    canvas.restore();
    // ③ 翻译行（跟在歌词后面）整行用已唱色：它们没有逐字信息，跟着本行走
    int lyricLastRow = layout.getLineForOffset(Math.max(lyricLength - 1, 0));
    if (lyricLastRow < layout.getLineCount() - 1) {
      canvas.save();
      canvas.clipRect(0f, layout.getLineTop(lyricLastRow + 1), layout.getWidth(), layout.getHeight());
      layout.draw(canvas);
      canvas.restore();
    }
  }

  private void scheduleWordInvalidate() {
    if (player == null || !player.isPlaying()) return;
    removeCallbacks(invalidateRunnable);
    postDelayed(invalidateRunnable, WORD_INVALIDATE_DELAY);
  }

  @Override
  protected void onDraw(Canvas canvas) {
    // 用框架排好的 Layout：它是唯一与「框架本来会画出来的文字」完全一致的排版
    Layout layout = getLayout();
    if (layout == null) return;

    TextPaint paint = getPaint();
    canvas.save();
    canvas.translate(getPaddingLeft(), getDrawY(layout.getHeight()));

    paint.setColor(unplayColor);
    layout.draw(canvas);

    float swept = getSweptCharPosition();
    if (swept < 0f) {
      // 没有逐字信息（或还没开始播）：整行用已唱色，与改动前一致
      paint.setColor(playedColor);
      layout.draw(canvas);
    } else {
      paint.setColor(playedColor);
      drawSwept(canvas, layout, swept);
      // 还有得唱才继续刷；唱完或暂停后自然停下，不空转
      if (swept < getLyricLength()) scheduleWordInvalidate();
    }

    canvas.restore();
  }

  @Override
  protected void onDetachedFromWindow() {
    removeCallbacks(invalidateRunnable);
    super.onDetachedFromWindow();
  }
}
