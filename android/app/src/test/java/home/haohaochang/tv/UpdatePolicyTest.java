package home.haohaochang.tv;

import static org.junit.Assert.*;

import org.junit.Test;

public class UpdatePolicyTest {
  static final String BUILD_INFO =
      "version=1.1.5.1\n"
      + "versionCode=44\n"
      + "commit=0ed49f3\n"
      + "applicationId=home.haohaochang.tv\n"
      + "debuggable=false\n"
      + "size=37748736\n"
      + "sha256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";

  @Test
  public void productionManifestUsesVersionedOfficialApkAndIntegerVersionCode() {
    UpdatePolicy.Release release = UpdatePolicy.parse((BUILD_INFO
        + "notes=APK 更新 = 官方渠道\n"
        + "apkUrl=https://elsewhere.invalid/foreign.apk\n").replace("\n", "\r\n"));
    assertEquals("1.1.5.1", release.version);
    assertEquals(44, release.versionCode);
    assertEquals(37748736, release.size);
    assertEquals("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", release.sha256);
    assertEquals("APK 更新 = 官方渠道", release.notes);
    assertEquals("https://dunn.fun/haohaochang/updates/v1.1.5.1/haohaochang-tv-v1.1.5.1.apk", release.apkUrl());
    assertTrue(release.newerThan(43));
    assertFalse(release.newerThan(44));
    assertFalse(release.newerThan(45));
  }

  @Test
  public void incompleteAmbiguousAndUnofficialBuildsAreRejected() {
    assertInvalid(BUILD_INFO + "versionCode=45\n");
    assertInvalid(BUILD_INFO + "sha256=wrong\n");
    assertInvalid(BUILD_INFO.replace("version=1.1.5.1", "version=1.1.5/../../other"));
    assertInvalid(BUILD_INFO.replace("version=1.1.5.1", "version=1.1.5-beta"));
    assertInvalid(BUILD_INFO.replace("versionCode=44", "versionCode=2147483648"));
    assertInvalid(BUILD_INFO.replace("debuggable=false", "debuggable=true"));
    assertInvalid(BUILD_INFO.replace("applicationId=home.haohaochang.tv", "applicationId=home.haohaochang.tv.debug"));
    assertInvalid(BUILD_INFO.replace("size=37748736", "size=268435457"));
    assertInvalid(BUILD_INFO.replace("size=37748736\n", ""));
    assertInvalid(BUILD_INFO.replace("AAAA", "invalid"));
  }

  private static void assertInvalid(String value) {
    assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.parse(value));
  }
}
