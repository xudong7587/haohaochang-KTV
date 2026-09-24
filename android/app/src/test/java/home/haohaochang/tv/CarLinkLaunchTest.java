package home.haohaochang.tv;

import static org.junit.Assert.*;

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {23, 28})
public class CarLinkLaunchTest {
  private static final String PACKAGE_NAME = BuildConfig.APPLICATION_ID;
  private static final String MAIN_ACTIVITY = MainActivity.class.getName();

  @Test
  public void ucarHostCanResolveTheExistingExportedActivity() {
    Intent intent = new Intent("com.ucar.intent.action.UCAR");
    intent.addCategory("com.ucar.intent.category.UCAR");
    assertSingleMainActivity(intent);
    ResolveInfo implicit = RuntimeEnvironment.getApplication().getPackageManager()
        .resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY);
    assertNotNull("An implicit UCAR launch must also resolve", implicit);
    assertEquals(MAIN_ACTIVITY, implicit.activityInfo.name);
  }

  @Test
  public void phoneLauncherStillHasExactlyOneEntry() {
    assertSingleMainActivity(
        new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER));
  }

  @Test
  public void televisionLauncherStillHasExactlyOneEntry() {
    assertSingleMainActivity(
        new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER));
  }

  @Test
  public void ucarActionAndHostModeExtraAreRecognized() {
    assertTrue(CarLinkLaunch.isCarLaunch(new Intent("com.ucar.intent.action.UCAR")));
    assertTrue(
        CarLinkLaunch.isCarLaunch(
            new Intent(Intent.ACTION_MAIN).putExtra("isUcarMode", true)));
    assertTrue(
        CarLinkLaunch.isCarLaunch(
            new Intent("com.ucar.intent.action.UCAR").putExtra("isUcarMode", false)));
  }

  @Test
  public void ordinaryLaunchesAndUnrelatedCarCategoriesDoNotEnableCarMode() {
    assertFalse(CarLinkLaunch.isCarLaunch(null));
    assertFalse(CarLinkLaunch.isCarLaunch(new Intent(Intent.ACTION_MAIN)));
    assertFalse(
        CarLinkLaunch.isCarLaunch(
            new Intent(Intent.ACTION_MAIN).putExtra("isUcarMode", false)));
    assertFalse(
        CarLinkLaunch.isCarLaunch(
            new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_CAR_DOCK)));
    assertFalse(
        CarLinkLaunch.isCarLaunch(
            new Intent(Intent.ACTION_MAIN).addCategory("com.ucar.intent.category.UCAR")));
  }

  @Test
  public void carLaunchLeavesOrientationToTheHostInsteadOfThePhoneSensor() {
    Intent byAction = new Intent("com.ucar.intent.action.UCAR");
    Intent byExtra = new Intent(Intent.ACTION_MAIN).putExtra("isUcarMode", true);
    for (boolean television : new boolean[] {false, true}) {
      assertEquals(
          ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
          CarLinkLaunch.orientation(byAction, television));
      assertEquals(
          ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
          CarLinkLaunch.orientation(byExtra, television));
    }
  }

  @Test
  public void ordinaryLaunchesKeepPhoneAndTelevisionOrientationPolicies() {
    Intent ordinary = new Intent(Intent.ACTION_MAIN);
    assertEquals(
        ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR,
        CarLinkLaunch.orientation(ordinary, false));
    assertEquals(
        ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,
        CarLinkLaunch.orientation(ordinary, true));
  }

  private static void assertSingleMainActivity(Intent intent) {
    PackageManager packageManager = RuntimeEnvironment.getApplication().getPackageManager();
    List<ResolveInfo> matches =
        packageManager.queryIntentActivities(intent.setPackage(PACKAGE_NAME), 0);
    assertEquals("The installed manifest must expose exactly one matching entry", 1, matches.size());
    ActivityInfo activity = matches.get(0).activityInfo;
    assertEquals(PACKAGE_NAME, activity.packageName);
    assertEquals(MAIN_ACTIVITY, activity.name);
    assertTrue("The car host and launchers must be able to open the activity", activity.exported);
    assertNull("Keep the original entry instead of creating a launcher alias", activity.targetActivity);
  }
}
