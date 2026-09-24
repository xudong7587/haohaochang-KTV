package home.haohaochang.tv;

import android.content.Intent;
import android.content.pm.ActivityInfo;

/** vivo CastKit entry used over ICCOA CarLink, CarLife and EasyConnection. */
final class CarLinkLaunch {
  static final String ACTION = "com.ucar.intent.action.UCAR";
  static final String CATEGORY = "com.ucar.intent.category.UCAR";

  static boolean isCarLaunch(Intent intent) {
    return intent != null
        && (ACTION.equals(intent.getAction()) || intent.getBooleanExtra("isUcarMode", false));
  }

  static int orientation(Intent intent, boolean television) {
    // CastKit can report PORTRAIT for a wide virtual display. Let the host
    // control its window instead of rotating it with the phone's sensor.
    if (isCarLaunch(intent)) return ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    return television
        ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        : ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR;
  }

  private CarLinkLaunch() {}
}
