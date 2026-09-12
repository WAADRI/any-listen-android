package cn.toside.music.mobile.lyric;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.util.Log;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableMap;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Objects;

public class Lyric extends LyricPlayer {
  LyricView lyricView = null;
  LyricEvent lyricEvent = null;
  ReactApplicationContext reactAppContext;

  boolean isRunPlayer = false;
  // String lastText = "LX Music ^-^";
  int lastLine = 0;
  List lines = new ArrayList();
  boolean isShowTranslation;
  boolean isShowRoma;
  boolean isShowLyricView = false;
  boolean isSendLyricTextEvent = false;
  boolean isScreenOff = false;
  String lyricText = "";
  String translationText = "";
  String romaLyricText = "";
  /** 閫愬瓧姝岃瘝锛堟湇鍔＄ awlyric锛孞S 渚цВ鏋愬悗浼犺繘鏉ワ級锛岀敤浜庢闈㈡瓕璇嶇殑閫愬瓧鎵厜 */
  List<WordLyric.Line> wordLines = new ArrayList<>();

  Lyric(ReactApplicationContext reactContext, boolean isShowTranslation, boolean isShowRoma, float playbackRate) {
    this.reactAppContext = reactContext;
    this.isShowTranslation = isShowTranslation;
    this.isShowRoma = isShowRoma;
    this.playbackRate = playbackRate;
    registerScreenBroadcastReceiver();
    // checkA2DPConnection(reactContext);
  }

  private void registerScreenBroadcastReceiver() {
    final IntentFilter theFilter = new IntentFilter();
    /** System Defined Broadcast */
    theFilter.addAction(Intent.ACTION_SCREEN_ON);
    theFilter.addAction(Intent.ACTION_SCREEN_OFF);

    BroadcastReceiver screenOnOffReceiver = new BroadcastReceiver() {
      @Override
      public void onReceive(Context context, Intent intent) {
        String strAction = intent.getAction();

        switch (Objects.requireNonNull(strAction)) {
          case Intent.ACTION_SCREEN_OFF:
            Log.d("Lyric", "ACTION_SCREEN_OFF");
            handleScreenOff();
            break;
          case Intent.ACTION_SCREEN_ON:
            Log.d("Lyric", "ACTION_SCREEN_ON");
            handleScreenOn();
            break;
        }
      }
    };

    reactAppContext.registerReceiver(screenOnOffReceiver, theFilter);
  }

  // private void checkA2DPConnection(Context context) {
  //   BluetoothAdapter bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();

  //   if (bluetoothAdapter != null && bluetoothAdapter.isEnabled()) {
  //     bluetoothAdapter.getProfileProxy(context, new BluetoothProfile.ServiceListener() {
  //       @Override
  //       public void onServiceConnected(int profile, BluetoothProfile proxy) {
  //         if (profile == BluetoothProfile.A2DP) {
  //           List<BluetoothDevice> connectedDevices = proxy.getConnectedDevices();
  //           if (!connectedDevices.isEmpty()) {
  //             System.out.println("宸茶繛鎺ョ殑 A2DP 濯掍綋璁惧锛?);
  //             for (BluetoothDevice device : connectedDevices) {
  //               System.out.println("璁惧鍚嶇О: " + "鍦板潃: " + device.getAddress());
  //             }
  //           } else {
  //             System.out.println("娌℃湁杩炴帴鐨?A2DP 濯掍綋璁惧");
  //           }
  //         }
  //         bluetoothAdapter.closeProfileProxy(profile, proxy);
  //       }

  //       @Override
  //       public void onServiceDisconnected(int profile) {
  //         // 鏈嶅姟鏂紑鏃剁殑澶勭悊
  //         System.out.println("钃濈墮鏈嶅姟鏂紑鏃剁殑澶勭悊");
  //       }
  //     }, BluetoothProfile.A2DP);
  //   } else {
  //     System.out.println("钃濈墮鏈紑鍚垨璁惧涓嶆敮鎸佽摑鐗?);
  //   }
  // }

  private boolean isDisableAutoPause() {
    return !isRunPlayer || isSendLyricTextEvent;
  }
  private void handleScreenOff() {
    isScreenOff = true;
    if (isDisableAutoPause()) return;
    setTempPause(true);
  }

  private void handleScreenOn() {
    isScreenOff = false;
    if (isDisableAutoPause()) return;
    if (lyricView == null) {
        lyricView = new LyricView(reactAppContext, lyricEvent);
        lyricView.setPlayer(this);
      }
    lyricView.runOnUiThread(() -> {
      handleGetCurrentLyric(lastLine);
      setTempPause(false);
    });
  }

  private void pausePlayer() {
    if (!isRunPlayer || isShowLyricView || isSendLyricTextEvent) return;
    isRunPlayer = false;
    this.pause();
  }

  private void setCurrentLyric(String lyric, ArrayList<String> extendedLyrics, WordLyric.Line wordLine) {
    if (isShowLyricView && !isScreenOff && lyricView != null) {
      if (wordLine == null) lyricView.setLyric(lyric, extendedLyrics, null, 0);
      else lyricView.setLyric(lyric, extendedLyrics, wordLine.segments, wordLine.time);
    }
    if (isSendLyricTextEvent) {
      WritableMap params = Arguments.createMap();
      params.putString("text", lyric);
      params.putArray("extendedLyrics", Arguments.makeNativeArray(extendedLyrics));
      lyricEvent.sendEvent(lyricEvent.LYRIC_Line_PLAY, params);
    }
  }
  private void handleGetCurrentLyric(int lineNum) {
    lastLine = lineNum;
    if (lineNum >= 0 && lineNum < lines.size()) {
      HashMap line = (HashMap) lines.get(lineNum);
      if (line != null) {
        String text = (String) line.get("text");
        Object time = line.get("time");
        // 閫愬瓧姝岃瘝鐢?JS 渚цВ鏋愶紝杩欒竟鐨勮搴?鍘婚噸瑙勫垯涓庡畠涓嶅畬鍏ㄤ竴鑷达紝
        // 鎵€浠ユ寜琛屾椂闂村尮閰嶃€佽鍙峰厹搴曪紝骞惰姹傛鏂囦竴鑷达紙瑙?WordLyric.findLine锛?
        WordLyric.Line wordLine = WordLyric.findLine(wordLines, lineNum, time == null ? -1 : (int) time, text);
        setCurrentLyric(text, (ArrayList<String>) line.get("extendedLyrics"), wordLine);
        return;
      }
    }
    setCurrentLyric("", new ArrayList<>(0), null);
  }

  public void setSendLyricTextEvent(boolean isSend) {
    if (isSendLyricTextEvent == isSend) return;
    isSendLyricTextEvent = isSend;
    if (isSend) {
      if (lyricEvent == null) lyricEvent = new LyricEvent(reactAppContext);
      isRunPlayer = true;
    } else {
      pausePlayer();
    }
  }

  public void showDesktopLyric(Bundle options, Promise promise) {
    if (isShowLyricView) return;
    if (lyricEvent == null) lyricEvent = new LyricEvent(reactAppContext);
    isShowLyricView = true;
    if (lyricView == null) {
        lyricView = new LyricView(reactAppContext, lyricEvent);
        lyricView.setPlayer(this);
      }
    try {
      lyricView.showLyricView(options);
    } catch (Exception e) {
      promise.reject(e);
      Log.e("Lyric", e.getMessage());
      return;
    }
    isRunPlayer = true;
    promise.resolve(null);
  }

  public void hideDesktopLyric() {
    if (!isShowLyricView) return;
    isShowLyricView = false;
    pausePlayer();
    if (lyricView != null) {
      lyricView.destroy();
      lyricView = null;
    }
  }

  private void refreshLyric() {
    if (!isRunPlayer) return;
    ArrayList<String> extendedLyrics = new ArrayList<>(2);
    if (isShowTranslation && !"".equals(translationText)) extendedLyrics.add(translationText);
    if (isShowRoma && !"".equals(romaLyricText)) extendedLyrics.add(romaLyricText);
    super.setLyric(lyricText, extendedLyrics);
  }

  public void setLyric(String lyric, String translation, String romaLyric, List<WordLyric.Line> wordLines) {
    lyricText = lyric;
    translationText = translation;
    romaLyricText = romaLyric;
    this.wordLines = wordLines == null ? new ArrayList<>() : wordLines;
    refreshLyric();
  }

  /**
   * 鎾斁/鏆傚仠鏃惰妗岄潰姝岃瘝鐨勬壂鍏夌珛鍒昏窡涓婏細鏆傚仠鏃跺畠鍐诲湪褰撳墠杩涘害锛?
   * 鎭㈠鎾斁鍚庡鏋滄病浜洪噸鐢伙紝灏变細涓€鐩村仠鍦ㄩ偅閲岀洿鍒颁笅涓€琛屻€?
   */
  @Override
  public void play(int curTime) {
    super.play(curTime);
    if (lyricView != null) lyricView.invalidateWordSweep();
  }

  @Override
  public void pause() {
    super.pause();
    if (lyricView != null) lyricView.invalidateWordSweep();
  }

  @Override
  public void onSetLyric(List lines) {
    this.lines = lines;
    handleGetCurrentLyric(-1);
    // for (int i = 0; i < lines.size(); i++) {
    //   HashMap line = (HashMap) lines.get(i);
    //   Log.d("Lyric", "onSetLyric: " +(String) line.get("text") + " " + line.get("extendedLyrics"));
    // }
  }

  @Override
  public void onPlay(int lineNum) {
    handleGetCurrentLyric(lineNum);
    // Log.d("Lyric", lineNum + " " + text + " " + (String) line.get("translation"));
  }

  public void pauseLyric() {
    pause();
    // 鏆傚仠鏃?*涓嶈**鎶婂綋鍓嶈娓呮帀銆?
    //
    // 涓婃父杩欓噷鍐欑殑鏄?`handleGetCurrentLyric(-1)`锛岃€?-1 浼氳惤鍒?
    // `setCurrentLyric("")` 鈥斺€?妗岄潰姝岃瘝绐楀彛鍦ㄦ殏鍋滅灛闂存暣鍧楀彉鎴愮┖鐨勶紙鐢ㄦ埛鍙鐨?
    // 缂洪櫡锛氭殏鍋滃悗姝岃瘝娑堝け锛屾仮澶嶆挱鏀炬墠鍥炴潵锛夈€傝€屼笖 `lastLine` 琚疆鎴?-1 涔嬪悗锛?
    // 鎭睆鍐嶄寒灞忔椂 `handleScreenOn` 鎭㈠鐨勪篃鏄┖琛屻€?
    //
    // 鐜板湪鍙殏鍋滆В鏋愬櫒锛氱獥鍙ｄ繚鎸佹樉绀哄綋鍓嶈锛宍lastLine` 涔熶繚鎸佸湪閭ｄ竴琛岋紝
    // 鎭㈠鎾斁鍚?`onPlay` 浼氱户缁粰鍑烘纭殑琛屻€傛崲姝屾椂 `onSetLyric` 浠嶄細娓呯┖锛?
    // 鍋滄鎾斁鏃?JS 渚т細 `setLyric('')`锛屼袱鏉℃竻绌鸿矾寰勯兘涓嶅彈褰卞搷銆?
  }

  public void lockLyric() {
    if (lyricView == null) return;
    lyricView.lockView();
  }

  public void unlockLyric() {
    if (lyricView == null) return;
    lyricView.unlockView();
  }

  public void setMaxLineNum(int maxLineNum) {
    if (lyricView == null) return;
    lyricView.setMaxLineNum(maxLineNum);
  }

  public void setWidth(int width) {
    if (lyricView == null) return;
    lyricView.setWidth(width);
  }

  public void setSingleLine(boolean singleLine) {
    if (lyricView == null) return;
    lyricView.setSingleLine(singleLine);
  }

  public void setShowToggleAnima(boolean showToggleAnima) {
    if (lyricView == null) return;
    lyricView.setShowToggleAnima(showToggleAnima);
  }

  public void toggleTranslation(boolean isShowTranslation) {
    this.isShowTranslation = isShowTranslation;
    refreshLyric();
  }

  public void toggleRoma(boolean isShowRoma) {
    this.isShowRoma = isShowRoma;
    refreshLyric();
  }

  public void setPlayedColor(String unplayColor, String playedColor, String shadowColor) {
    if (lyricView == null) return;
    lyricView.setColor(unplayColor, playedColor, shadowColor);
  }

  public void setAlpha(float alpha) {
    if (lyricView == null) return;
    lyricView.setAlpha(alpha);
  }

  public void setTextSize(float size) {
    if (lyricView == null) return;
    lyricView.setTextSize(size);
  }

  public void setLyricTextPosition(String positionX, String positionY) {
    if (lyricView == null) return;
    lyricView.setLyricTextPosition(positionX, positionY);
  }
}
