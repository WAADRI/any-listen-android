package cn.toside.music.mobile.lyric;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.text.TextPaint;
import android.text.TextUtils;
import android.view.View;
import android.view.animation.AlphaAnimation;
import android.view.animation.Animation;
import android.view.animation.AnimationSet;
import android.view.animation.TranslateAnimation;
import android.widget.TextSwitcher;
import android.widget.TextView;

import androidx.annotation.Nullable;

import java.util.ArrayList;
import java.util.List;

// https://github.com/Block-Network/StatusBarLyric/blob/main/app/src/main/java/statusbar/lyric/view/LyricSwitchView.kt
@SuppressLint({"ViewConstructor"})
public final class LyricSwitchView extends TextSwitcher {
  private final TextView textView;
  private final TextView textView2;
  private final ArrayList<TextView> viewArray;
  // private final boolean isSingleLine;
  private boolean isShowAnima;

  private boolean isSingleLine;

  // 当前行的逐字信息：`TextSwitcher` 把文字写到「下一个」view，逐字信息也要跟着写过去，
  // 否则切换动画期间旧行会拿新行的逐字时间去扫（画出来就是乱的）
  private List<WordLyric.Segment> wordSegments = null;
  private int wordLineTime = 0;
  private LyricPlayer wordPlayer = null;

  public LyricSwitchView(Context context, boolean isSingleLine, boolean isShowAnima) {
    super(context);
    // this.isSingleLine = isSingleLine;
    this.isShowAnima = isShowAnima;
    this.isSingleLine = isSingleLine;

    if (isSingleLine) {
      viewArray = new ArrayList<>(2);
      textView = new LyricTextView(context);
      textView2 = new LyricTextView(context);
      viewArray.add(textView);
      viewArray.add(textView2);
//      for (TextView v : viewArray) {
//        v.setShadowLayer(0.1f, 0, 0, Color.BLACK);
//      }
    } else {
      // 多行模式也要逐字扫光，所以用自绘控件（普通 TextView 的文字由框架一次画完，
      // 外部没法只画「已唱到的那一部分」）
      viewArray = new ArrayList<>(2);
      textView = new LyricMultilineTextView(context);
      textView2 = new LyricMultilineTextView(context);
      viewArray.add(textView);
      viewArray.add(textView2);
      for (TextView v : viewArray) {
//        v.setShadowLayer(0.2f, 0, 0, Color.BLACK);
        v.setEllipsize(TextUtils.TruncateAt.END);
      }
    }
    setAnima();
    this.addView(textView);
    this.addView(textView2);
  }

  /**
   * 下一个要被显示的 view。
   *
   * `ViewAnimator.getNextView()` 是包内可见的，子类调不到，所以用公开的
   * `getCurrentView()` 反推：两个子 view 里「不是当前那个」就是下一个。
   */
  private TextView getNextLyricView() {
    View current = getCurrentView();
    if (current == null || current == textView2) return textView;
    return textView2;
  }

  @Override
  public void setText(CharSequence text) {
    TextView nextView = getNextLyricView();
    if (nextView instanceof WordLyricView && wordPlayer != null) {
      ((WordLyricView) nextView).setWordLyric(wordSegments, wordLineTime, wordPlayer);
    }
    super.setText(text);
  }

  /** 记住当前行的逐字信息，等 `setText` 时交给真正要显示的那个 view */
  public void setWordLyric(List<WordLyric.Segment> segments, int lineTime, LyricPlayer player) {
    wordSegments = segments;
    wordLineTime = lineTime;
    wordPlayer = player;
  }

  public void setUnplayColor(int color) {
    for (TextView v : viewArray) {
      if (v instanceof WordLyricView) ((WordLyricView) v).setUnplayColor(color);
    }
  }

  /** 把播放器交给两个 view（它们自己按播放位置算扫到哪了） */
  public void setPlayer(LyricPlayer player) {
    wordPlayer = player;
    for (TextView v : viewArray) {
      if (v instanceof WordLyricView) ((WordLyricView) v).setPlayer(player);
    }
  }

  /** 播放/暂停切换后让扫光重新动起来（暂停时扫光冻在当前进度，恢复后要接着走） */
  public void invalidateWordSweep() {
    for (TextView v : viewArray) {
      if (v instanceof WordLyricView) ((WordLyricView) v).invalidateWordSweep();
    }
  }

  @Nullable
  public Animation inAnim(String str, float height) {
    AnimationSet animationSet = new AnimationSet(true);
    if (str == null) return null;

    TranslateAnimation translateAnimation;
    switch (str) {
      case "top":
        translateAnimation = new TranslateAnimation(0.0F, 0.0F, height, 0.0F);
        break;
      case "bottom":
        translateAnimation = new TranslateAnimation(0.0F, 0.0F, -height, 0.0F);
        break;
      case "left":
        translateAnimation = new TranslateAnimation(100.0F, 0.0F, 0.0F, 0.0F);
        break;
      case "right":
        translateAnimation = new TranslateAnimation(-100.0F, 0.0F, 0.0F, 0.0F);
        break;
      default: return null;
    }

    translateAnimation.setDuration(300L);
    AlphaAnimation alphaAnimation = new AlphaAnimation(0.0F, 1.0F);
    alphaAnimation.setDuration(300L);
    animationSet.addAnimation(translateAnimation);
    animationSet.addAnimation(alphaAnimation);
    return animationSet;
  }

  @Nullable
  public Animation outAnim(String str, float height) {
    AnimationSet animationSet = new AnimationSet(true);
    if (str == null) return null;

    TranslateAnimation translateAnimation;
    switch (str) {
      case "top":
        translateAnimation = new TranslateAnimation(0.0F, 0.0F, 0.0F, -height);
        break;
      case "bottom":
        translateAnimation = new TranslateAnimation(0.0F, 0.0F, 0.0F, height);
        break;
      case "left":
        translateAnimation = new TranslateAnimation(0.0F, -100.0F, 0.0F, 0.0F);
        break;
      case "right":
        translateAnimation = new TranslateAnimation(0.0F, 100.0F, 0.0F, 0.0F);
        break;
      default: return null;
    }
    translateAnimation.setDuration(300L);
    AlphaAnimation alphaAnimation = new AlphaAnimation(1.0F, 0.0F);
    alphaAnimation.setDuration(300L);
    animationSet.addAnimation(translateAnimation);
    animationSet.addAnimation(alphaAnimation);
    return animationSet;
  }

  private void setAnima() {
    if (textView == null) return;
    if (isShowAnima) {
      float size = textView.getTextSize();
      setInAnimation(inAnim("top", size));
      setOutAnimation(outAnim("top", size));
    } else {
      setInAnimation(null);
      setOutAnimation(null);
    }
  }

  public void setShowAnima(boolean showAnima) {
    isShowAnima = showAnima;
    setAnima();
  }

  public CharSequence getText() {
    View currentView = this.getCurrentView();
    return currentView == null ? "" : ((TextView)currentView).getText();
  }

  public TextPaint getPaint() {
    TextView v = (TextView)this.getCurrentView();
    if (v == null) return null;
    return v.getPaint();
  }

  public void setWidth(int i) {
    for (TextView v : viewArray) v.setWidth(i);
  }

  public void setTextColor(int i) {
    for (TextView v : viewArray) v.setTextColor(i);
  }

  public void setShadowColor(int i) {
    // float radius;
    // if (isSingleLine) {
    //   radius = 1.2f;
    // } else {
    //   radius = 2f;
    // }
    // https://stackoverflow.com/a/28367917
    for (TextView v : viewArray) v.setShadowLayer(1.6f, 1.5f, 1.3f, i);
  }

  public void setSourceText(CharSequence str) {
    for (TextView v : viewArray) v.setText(str);
  }

  public void setLetterSpacings(float letterSpacing) {
    for (TextView v : viewArray) v.setLetterSpacing(letterSpacing);
  }

  public void setHeight(int i) {
    for (TextView v : viewArray) v.setHeight(i);
  }

  public void setTypeface(Typeface typeface) {
    for (TextView v : viewArray) v.setTypeface(typeface);
  }

  public void setSingleLine(boolean bool) {
    for (TextView v : viewArray) v.setSingleLine(bool);
  }

  public void setMaxLines(int i) {
    for (TextView v : viewArray) v.setMaxLines(i);
  }

  public void setTextSize(float f) {
    for (TextView v : viewArray) v.setTextSize(f);
    setAnima();
  }

  public void setGravity(int i) {
    for (TextView v : viewArray) v.setGravity(i);
  }

}
