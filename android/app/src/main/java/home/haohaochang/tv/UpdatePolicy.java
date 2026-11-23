package home.haohaochang.tv;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

final class UpdatePolicy {
  static final String APPLICATION_ID = "home.haohaochang.tv";
  private static final String DIRECTORY = "https://dunn.fun/haohaochang/updates/";
  static final String BUILD_INFO_URL = DIRECTORY + "latest/BUILD_INFO.txt";
  static final int MAX_BUILD_INFO_BYTES = 16384;
  private static final long MAX_APK_BYTES = 256L * 1024 * 1024;

  static final class Release {
    final String version, notes, sha256;
    final long versionCode, size;

    private Release(String version, long versionCode, long size, String sha256, String notes) {
      this.version = version;
      this.versionCode = versionCode;
      this.size = size;
      this.sha256 = sha256;
      this.notes = notes;
    }

    String apkUrl() {
      return DIRECTORY + "v" + version + "/haohaochang-tv-v" + version + ".apk";
    }

    boolean newerThan(long installed) {
      return versionCode > installed;
    }
  }

  static Release parse(String text) {
    Map<String, String> fields = new HashMap<>();
    for (String line : text.split("\\r?\\n")) {
      if (line.trim().isEmpty() || line.startsWith("#")) continue;
      int separator = line.indexOf('=');
      if (separator < 1) throw invalidBuild();
      String key = line.substring(0, separator);
      String value = line.substring(separator + 1);
      switch (key) {
        case "version":
        case "versionCode":
        case "applicationId":
        case "debuggable":
        case "size":
        case "sha256":
          if (fields.put(key, value) != null) throw invalidBuild();
          break;
        case "notes":
          fields.put(key, value);
          break;
        default:
          // The host may publish extra data such as the source commit.
      }
    }
    String version = Objects.toString(fields.get("version"), "");
    String sha256 = Objects.toString(fields.get("sha256"), "");
    String notes = Objects.toString(fields.get("notes"), "");
    if (!APPLICATION_ID.equals(fields.get("applicationId"))
        || !"false".equals(fields.get("debuggable"))
        || !version.matches("[0-9]{1,9}(\\.[0-9]{1,9}){2,3}")
        || !sha256.matches("[a-fA-F0-9]{64}")
        || notes.length() > 2000) throw invalidBuild();
    long versionCode = positiveDecimal(fields.get("versionCode"), Integer.MAX_VALUE);
    long size = positiveDecimal(fields.get("size"), MAX_APK_BYTES);
    return new Release(version, versionCode, size, sha256.toLowerCase(Locale.ROOT), notes);
  }

  private static long positiveDecimal(String value, long max) {
    if (value == null || !value.matches("[1-9][0-9]{0,9}")) throw invalidBuild();
    long result = Long.parseLong(value);
    if (result > max) throw invalidBuild();
    return result;
  }

  private static IllegalArgumentException invalidBuild() {
    return new IllegalArgumentException("官方版本信息无效");
  }
}
