package home.haohaochang.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import okhttp3.CacheControl;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

final class AppUpdater {
  private static final OkHttpClient HTTP = new OkHttpClient.Builder()
      .followRedirects(false)
      .followSslRedirects(false)
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(20, TimeUnit.SECONDS)
      .callTimeout(10, TimeUnit.MINUTES)
      .build();
  private final Activity activity;
  private Operation operation;
  private File waitingPermission;

  private static final class Operation {
    volatile boolean cancelled;
    volatile Call call;

    void cancel() {
      cancelled = true;
      Call active = call;
      if (active != null) active.cancel();
    }
  }

  private interface Work {
    Runnable run(Operation request, AlertDialog progress) throws Exception;
  }

  AppUpdater(Activity activity) {
    this.activity = activity;
  }

  void check() {
    if (BuildConfig.DEBUG || !UpdatePolicy.APPLICATION_ID.equals(activity.getPackageName())) {
      message("测试版请手动安装新版测试 APK。");
      return;
    }
    run("检查更新", "正在读取官网版本信息…", (request, progress) -> {
      UpdatePolicy.Release release = UpdatePolicy.parse(readBuildInfo(request));
      PackageInfo installed = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
      if (!release.newerThan(versionCode(installed)))
        return () -> message("当前版本 " + installed.versionName + " 已是最新版本。");
      return () -> offerDownload(release);
    });
  }

  private void offerDownload(UpdatePolicy.Release release) {
    String details = "下载并校验后，可在电视上安装。连接设置会保留。";
    if (!release.notes.isEmpty()) details = release.notes + "\n\n" + details;
    new AlertDialog.Builder(activity)
        .setTitle("发现新版 " + release.version)
        .setMessage(details)
        .setPositiveButton("下载更新", (d, w) -> download(release))
        .setNegativeButton("稍后", null)
        .show();
  }

  private void download(UpdatePolicy.Release release) {
    run("下载新版 " + release.version, "正在连接官方下载地址…", (request, progress) -> {
      File directory = UpdateProvider.directory(activity);
      if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法打开更新缓存");
      File partial = File.createTempFile("update-", ".part.apk", directory);
      try {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        long total = 0;
        int lastPercent = -1;
        try (Response response = fetch(request, release.apkUrl());
            InputStream input = response.body().byteStream();
            FileOutputStream output = new FileOutputStream(partial)) {
          byte[] buffer = new byte[65536];
          int count;
          while ((count = input.read(buffer)) != -1) {
            total += count;
            if (total > release.size) throw new IOException("文件大小不匹配");
            output.write(buffer, 0, count);
            hash.update(buffer, 0, count);
            int percent = (int) (total * 100 / release.size);
            if (percent == lastPercent) continue;
            lastPercent = percent;
            ui(() -> {
              if (!request.cancelled) progress.setMessage("已下载 " + percent + "%");
            });
          }
        }
        if (total != release.size || !release.sha256.equals(hex(hash.digest())))
          throw new IOException("下载校验失败");
        if (request.cancelled) throw new IOException("已取消");
        verify(partial, release);
        File apk = new File(directory, "update-" + release.sha256 + ".apk");
        if (!partial.renameTo(apk)) throw new IOException("无法保存安装包");
        pruneOlderFiles(directory, apk);
        return () -> offerInstall(apk);
      } finally {
        partial.delete();
      }
    });
  }

  private static void pruneOlderFiles(File directory, File current) {
    long oldest = System.currentTimeMillis() - TimeUnit.DAYS.toMillis(1);
    File[] files = directory.listFiles();
    if (files != null)
      for (File file : files)
        if (!file.equals(current) && file.lastModified() < oldest) file.delete();
  }

  private static String readBuildInfo(Operation request) throws Exception {
    try (Response response = fetch(request, UpdatePolicy.BUILD_INFO_URL);
        InputStream input = response.body().byteStream()) {
      ByteArrayOutputStream data = new ByteArrayOutputStream();
      byte[] buffer = new byte[4096];
      int count;
      while ((count = input.read(buffer)) != -1) {
        if (data.size() + count > UpdatePolicy.MAX_BUILD_INFO_BYTES) throw new IOException("版本信息过大");
        data.write(buffer, 0, count);
      }
      return data.toString("UTF-8");
    }
  }

  private static Response fetch(Operation operation, String url) throws IOException {
    Call call = HTTP.newCall(new Request.Builder()
        .url(url)
        .header("User-Agent", "HaohaochangTV/" + BuildConfig.VERSION_NAME)
        .header("Accept-Encoding", "identity")
        .cacheControl(CacheControl.FORCE_NETWORK)
        .build());
    operation.call = call;
    if (operation.cancelled) call.cancel();
    Response response = call.execute();
    if (response.code() == 200 && response.body() != null) return response;
    int code = response.code();
    response.close();
    throw new IOException("官方更新暂不可用（HTTP " + code + "）");
  }

  private void run(String title, String status, Work work) {
    if (operation != null) return;
    Operation request = new Operation();
    operation = request;
    AlertDialog progress = new AlertDialog.Builder(activity)
        .setTitle(title)
        .setMessage(status)
        .setNegativeButton("取消", (d, w) -> request.cancel())
        .create();
    progress.setOnCancelListener(d -> request.cancel());
    progress.show();
    new Thread(() -> {
      Runnable next;
      try {
        next = work.run(request, progress);
      } catch (Exception error) {
        next = () -> message(title + "失败：" + error.getMessage());
      }
      Runnable result = next;
      ui(() -> {
        operation = null;
        progress.dismiss();
        if (!request.cancelled) result.run();
      });
    }, "tv-update").start();
  }

  @SuppressWarnings("deprecation")
  private void verify(File file, UpdatePolicy.Release release) throws Exception {
    PackageManager pm = activity.getPackageManager();
    int signatures = Build.VERSION.SDK_INT >= 28
        ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    PackageInfo next = pm.getPackageArchiveInfo(file.getAbsolutePath(), signatures);
    PackageInfo installed = pm.getPackageInfo(activity.getPackageName(), signatures);
    if (!matchesInstalledApp(installed, next, release))
      throw new IOException("安装包名称、版本或签名不匹配");
  }

  static boolean matchesInstalledApp(PackageInfo installed, PackageInfo next, UpdatePolicy.Release release) {
    return next != null
        && UpdatePolicy.APPLICATION_ID.equals(next.packageName)
        && next.packageName.equals(installed.packageName)
        && next.applicationInfo != null
        && (next.applicationInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0
        && release.version.equals(next.versionName)
        && release.versionCode == versionCode(next)
        && release.newerThan(versionCode(installed))
        && sameSigners(certificates(installed), certificates(next));
  }

  @SuppressWarnings("deprecation")
  private static long versionCode(PackageInfo info) {
    return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
  }

  @SuppressWarnings("deprecation")
  private static Signature[] certificates(PackageInfo info) {
    if (Build.VERSION.SDK_INT < 28) return info.signatures;
    return info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
  }

  private static boolean sameSigners(Signature[] installed, Signature[] next) {
    return installed != null && installed.length > 0 && next != null
        && new HashSet<>(Arrays.asList(installed)).equals(new HashSet<>(Arrays.asList(next)));
  }

  private static String hex(byte[] bytes) {
    StringBuilder result = new StringBuilder();
    for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 255));
    return result.toString();
  }

  private void offerInstall(File apk) {
    new AlertDialog.Builder(activity)
        .setTitle("更新已下载")
        .setMessage("请在系统安装界面确认更新。")
        .setPositiveButton("安装更新", (d, w) -> install(apk))
        .setNegativeButton("稍后", null)
        .show();
  }

  private void install(File apk) {
    try {
      if (!apk.isFile()) throw new IOException("请重新下载更新包");
      if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
        new AlertDialog.Builder(activity)
            .setTitle("允许安装更新")
            .setMessage("请在系统设置中允许好好唱安装应用，然后返回继续。")
            .setPositiveButton("打开设置", (d, w) -> requestInstallPermission(apk))
            .setNegativeButton("取消", null)
            .show();
        return;
      }
      Uri uri = Uri.parse("content://" + activity.getPackageName() + ".updates/" + apk.getName());
      Intent intent = new Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, UpdateProvider.APK_MIME)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      intent.setClipData(ClipData.newRawUri("好好唱更新", uri));
      activity.startActivity(intent);
    } catch (Exception error) {
      message("无法安装：" + error.getMessage());
    }
  }

  private void requestInstallPermission(File apk) {
    try {
      waitingPermission = apk;
      activity.startActivity(new Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:" + activity.getPackageName())));
    } catch (Exception error) {
      waitingPermission = null;
      message("设备不支持打开安装权限设置");
    }
  }

  void resume() {
    File apk = waitingPermission;
    waitingPermission = null;
    if (apk != null && Build.VERSION.SDK_INT >= 26) {
      if (activity.getPackageManager().canRequestPackageInstalls()) install(apk);
      else offerInstall(apk);
    }
  }

  void destroy() {
    if (operation != null) operation.cancel();
  }

  private void ui(Runnable work) {
    activity.runOnUiThread(() -> {
      if (!activity.isFinishing() && !activity.isDestroyed()) work.run();
    });
  }

  private void message(String value) {
    new AlertDialog.Builder(activity)
        .setTitle("好好唱更新")
        .setMessage(value)
        .setPositiveButton("确定", null)
        .show();
  }
}
