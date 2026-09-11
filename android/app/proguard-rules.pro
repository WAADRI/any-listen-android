# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# 保留源文件名与行号。release 包开启了混淆（build.gradle 的
# enableProguardInReleaseBuilds），不加这条时异常与崩溃堆栈会退化成
# (SourceFile:0) 这种无法定位的形式；本项目靠 CI 出包、只能用 logcat 排查，
# 这条是日志可用的前提，体积影响可忽略。
#
# 注意**不要**再加 -renamesourcefileattribute：那会把真实文件名也抹掉，
# 堆栈重新变成无法定位的 (SourceFile:123)。
-keepattributes SourceFile,LineNumberTable

# Add any project specific keep options here:

-keep class com.reactnativenavigation.views.element.animators.** { *; }
# -keepclassmembers class com.reactnativenavigation.views.element.animators.** { *; }


-keep class org.jaudiotagger.tag.** { *; }


-keep public class com.dylanvann.fastimage.* {*;}
-keep public class com.dylanvann.fastimage.** {*;}
-keep public class * implements com.bumptech.glide.module.GlideModule
-keep public class * extends com.bumptech.glide.module.AppGlideModule
-keep public enum com.bumptech.glide.load.ImageHeaderParser$** {
  **[] $VALUES;
  public *;
}
