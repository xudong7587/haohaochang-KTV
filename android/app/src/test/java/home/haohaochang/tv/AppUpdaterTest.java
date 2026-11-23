package home.haohaochang.tv;

import static org.junit.Assert.*;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.Signature;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 23)
@SuppressWarnings("deprecation")
public class AppUpdaterTest {
  @Test
  public void archiveMustBeTheSignedProductionPackageWithTheManifestVersion() {
    UpdatePolicy.Release release = UpdatePolicy.parse(UpdatePolicyTest.BUILD_INFO);
    Signature original = new Signature(new byte[] {1});
    Signature second = new Signature(new byte[] {2});
    PackageInfo installed = packageInfo("1.1.5", 43, original, second);
    PackageInfo archive = packageInfo("1.1.5.1", 44, second, original);
    assertTrue(AppUpdater.matchesInstalledApp(installed, archive, release));

    archive.signatures = new Signature[] {original};
    assertFalse(AppUpdater.matchesInstalledApp(installed, archive, release));
    archive.signatures = new Signature[] {original, second};
    archive.applicationInfo.flags = ApplicationInfo.FLAG_DEBUGGABLE;
    assertFalse(AppUpdater.matchesInstalledApp(installed, archive, release));
    archive.applicationInfo.flags = 0;
    archive.packageName = "home.haohaochang.tv.debug";
    assertFalse(AppUpdater.matchesInstalledApp(installed, archive, release));
    archive.packageName = UpdatePolicy.APPLICATION_ID;
    archive.versionCode = 45;
    assertFalse(AppUpdater.matchesInstalledApp(installed, archive, release));
    archive.versionCode = 44;
    archive.versionName = "1.1.5.2";
    assertFalse(AppUpdater.matchesInstalledApp(installed, archive, release));
    archive.versionName = "1.1.5.1";
    installed.versionCode = 44;
    assertFalse(AppUpdater.matchesInstalledApp(installed, archive, release));
  }

  private static PackageInfo packageInfo(String version, int versionCode, Signature... signatures) {
    PackageInfo info = new PackageInfo();
    info.packageName = UpdatePolicy.APPLICATION_ID;
    info.versionName = version;
    info.versionCode = versionCode;
    info.signatures = signatures;
    info.applicationInfo = new ApplicationInfo();
    return info;
  }
}
