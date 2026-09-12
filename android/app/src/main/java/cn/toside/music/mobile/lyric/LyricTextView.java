package cn.toside.music.mobile.lyric;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.util.Log;
import android.view.Gravity;
import android.widget.TextView;

import java.util.List;

// https://github.com/Block-Network/StatusBarLyric/blob/main/app/src/main/java/statusbar/lyric/view/LyricTextView.kt
@SuppressLint("AppCompatCustomView")
public class LyricTextView extends TextView implements WordLyricView {
  private boolean isStop = true;
  private float textLength = 0F;
  private float viewWidth = 0F;
  private float viewHeight = 0F;
  private final float SPEED_LIMIT = 0.135F;
  private float speed;
  private float xx = 0F;
  private int gravityVertical = Gravity.TOP;
  private int gravityHorizontal = Gravity.CENTER;
  private float y = 0F;
  private String text = null;
  private final Paint mPaint;
  private final Runnable mStartScrollRunnable;
  private final Runnable invalidateRunnable;
  public static final int startScrollDelay = 1500;
  public static final int invalidateDelay = 10;

  // 逐字扫光：未唱色画一遍，已唱色裁到「唱到的位置」再画一遍
  private static final int WORD_INVALIDATE_DELAY = 16;
  private int unplayColor;
  private int playedColor;
  private List<WordLyric.Segment> wordSegments = null;
  private int wordLineTime = 0;
  private LyricPlayer player = null;
  private final Runnable wordInvalidateRunnable;

  public LyricTextView(Context context) {
    super(context);
    mStartScrollRunnable = LyricTextView.this::startScroll;
    invalidateRunnable = LyricTextView.this::invalidate;
    wordInvalidateRunnable = LyricTextView.this::invalidate;
    mPaint = getPaint();
    speed = SPEED_LIMIT * getTextSize();
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
    setTextColor(color);
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

  /**
   * 已经唱到文字的第几个像素。返回 -1 表示这一行没有逐字信息（整行用已唱色）。
   *
   * 位置由「已唱到第几个字」（{@link WordLyric#charPositionAt}）用当前画笔量出来，
   * 字内还按比例插值，所以扫过的时候是在一个字**内部**推进，而不是整字跳变。
   */
  private float getSweptWidth() {
    if (wordSegments == null || wordSegments.isEmpty() || player == null || !player.hasPlayed() || text == null) return -1F;
    float charPosition = WordLyric.charPositionAt(wordSegments, player.getCurrentTimeMs() - wordLineTime);
    int index = (int) charPosition;
    float fraction = charPosition - index;
    if (index >= text.length()) return textLength;
    float before = mPaint.measureText(text, 0, index);
    float current = index + 1 <= text.length() ? mPaint.measureText(text, index, index + 1) : 0F;
    return Math.min(before + current * fraction, textLength);
  }

  private void scheduleWordInvalidate() {
    if (player == null || !player.isPlaying()) return;
    removeCallbacks(wordInvalidateRunnable);
    postDelayed(wordInvalidateRunnable, WORD_INVALIDATE_DELAY);
  }


  private void init() {
    xx = 0.0F;
    textLength = getTextLength();
    // viewWidth = (float) getWidth();
  }

  @Override
  protected void onDetachedFromWindow() {
    removeCallbacks(mStartScrollRunnable);
    removeCallbacks(wordInvalidateRunnable);
    super.onDetachedFromWindow();
  }

  @Override
  protected void onTextChanged(CharSequence text, int start, int lengthBefore, int lengthAfter) {
    super.onTextChanged(text, start, lengthBefore, lengthAfter);
    stopScroll();
    this.text = text.toString();
    init();
    postInvalidate();
    postDelayed(mStartScrollRunnable, startScrollDelay);
  }

  @Override
  public void setTextColor(int color) {
    if (mPaint != null) mPaint.setColor(color);
    postInvalidate();
  }

  @Override
  public void setShadowLayer(float radius, float dx, float dy, int shadowColor) {
    if (mPaint != null) mPaint.setShadowLayer(radius, dx, dy, shadowColor);
    post(mStartScrollRunnable);
  }

  @Override
  public void setTextSize(float size) {
    super.setTextSize(size);
    speed = SPEED_LIMIT * size;
    if (text == null) return;
    post(mStartScrollRunnable);
  }

  @Override
  public void setWidth(int pixels) {
    super.setWidth(pixels);
    viewWidth = pixels;
    if (text == null) return;
    post(mStartScrollRunnable);
  }

  @Override
  public void setHeight(int pixels) {
    super.setHeight(pixels);
    viewHeight = pixels;
    y = getDrawY();
    if (text == null) return;
    post(mStartScrollRunnable);
  }

  @Override
  public void setGravity(int gravity) {
    if ((gravity & Gravity.RELATIVE_HORIZONTAL_GRAVITY_MASK) == 0) {
      gravity |= Gravity.START;
    }
    if ((gravity & Gravity.VERTICAL_GRAVITY_MASK) == 0) {
      gravity |= Gravity.TOP;
    }

    gravityVertical = gravity & Gravity.VERTICAL_GRAVITY_MASK;
    gravityHorizontal = gravity & Gravity.RELATIVE_HORIZONTAL_GRAVITY_MASK;

    y = getDrawY();
    // Log.d("Lyric", "gravityVertical: " + gravityVertical + " gravityHorizontal: " + gravityHorizontal);

    if (text == null) return;
    post(mStartScrollRunnable);
  }

  @Override
  protected void onDraw(Canvas canvas) {
    float mSpeed = speed;
    if (text != null) {
      Log.d("Lyric", "getHeight: " + getHeight() + " y: " + y);
      float drawX = getDrawX();
      mPaint.setColor(unplayColor);
      canvas.drawText(text, drawX, y, mPaint);

      float swept = getSweptWidth();
      if (swept < 0F) {
        // 没有逐字信息（或还没开始播）：整行用已唱色，与改动前一致
        mPaint.setColor(playedColor);
        canvas.drawText(text, drawX, y, mPaint);
      } else {
        if (swept > 0F) {
          canvas.save();
          canvas.clipRect(drawX, 0F, drawX + swept, getHeight());
          mPaint.setColor(playedColor);
          canvas.drawText(text, drawX, y, mPaint);
          canvas.restore();
        }
        // 还有得唱才继续刷；唱完或暂停后自然停下，不空转
        if (swept < textLength) scheduleWordInvalidate();
      }

      if (getText().length() >= 20) {
        mSpeed += mSpeed;
      }
    }

    if (!isStop) {
      if (viewWidth - xx + mSpeed >= textLength) {
        xx = viewWidth - textLength - 2;
        stopScroll();
      } else {
        xx -= mSpeed;
      }

      invalidateAfter();
    }

  }

  private void invalidateAfter() {
    removeCallbacks(invalidateRunnable);
    postDelayed(invalidateRunnable, invalidateDelay);
  }

  private void startScroll() {
    init();
    isStop = false;
    postInvalidate();
  }

  private void stopScroll() {
    isStop = true;
    removeCallbacks(mStartScrollRunnable);
    postInvalidate();
  }

  private float getTextLength() {
    return mPaint == null ? 0.0F : mPaint.measureText(text);
  }

  private float getDrawY() {
    Paint.FontMetrics fontMetrics = mPaint.getFontMetrics();
    float top = fontMetrics.top;
    float bottom = fontMetrics.bottom;
    float ascent = fontMetrics.ascent;
    // float descent = fontMetrics.descent;

    float y;

    // float y = Math.abs(mPaint.ascent() + mPaint.descent()) / 2;
    switch (gravityVertical) {
      case Gravity.CENTER_VERTICAL:
        y = viewHeight / 2F + (bottom - top) / 2 - bottom;
        break;
      case Gravity.BOTTOM:
        y = viewHeight - bottom;
        break;
      default:
        y = -ascent;
        break;
    }
    return y;
  }

  private float getDrawX() {
    float x;
    if (textLength < viewWidth) {
      switch (gravityHorizontal) {
        case Gravity.CENTER_HORIZONTAL:
          x = (viewWidth - textLength) / 2;
          break;
        case Gravity.END:
          x = viewWidth - textLength;
          break;
        default:
          x = 0;
          break;
      }
      isStop = true;
    } else {
      x = xx;
    }
    return x;
  }

  // public void setSpeed(float speed) {
  //  this.speed = speed;
  // }

}
