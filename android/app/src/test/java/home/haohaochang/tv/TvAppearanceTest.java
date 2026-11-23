package home.haohaochang.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlertDialog;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class TvAppearanceTest {
  @Test
  public void classicKeepsCurrentColorAndGeometry() {
    Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
    TvAppearance appearance = new TvAppearance(activity);
    assertNull(TvAppearance.of(appearance.context));
    assertEquals(TvStyle.INK, TvStyle.text(appearance.context, "测试", 16, TvStyle.INK).getCurrentTextColor());
    assertEquals(TvStyle.dp(activity, 10), TvStyle.shape(appearance.context, Color.RED, 10).getCornerRadius(), .01f);
    activity.finish();
  }

  @Test
  public void sunnyRestoresSeparateToneTexturePaletteAndCorners() {
    Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
    SharedPreferences settings = activity.getSharedPreferences("native-room", Activity.MODE_PRIVATE);
    settings.edit().putString("appearance-style", "sunny")
        .putString("appearance-theme", "dark").putString("appearance-material", "metal")
        .putString("appearance-color", "celadon").putString("appearance-corner", "round").apply();
    TvAppearance appearance = new TvAppearance(activity);
    assertNotNull(appearance.texture());
    assertEquals(0xff8fd6c9, appearance.accent());
    TextView label = TvStyle.text(appearance.context, "测试", 16, TvStyle.INK);
    assertEquals(0xffe9eef6, label.getCurrentTextColor());
    assertEquals(TvStyle.dp(activity, 19), TvStyle.shape(appearance.context, Color.RED, 10).getCornerRadius(), .01f);
    LinearLayout layout = new LinearLayout(appearance.context);
    layout.addView(label);
    Button button = TvStyle.button(appearance.context, "测试", "测试", () -> {});
    layout.addView(button);
    LinearLayout panel = new LinearLayout(appearance.context);
    panel.setBackground(TvStyle.surface(appearance.context, Color.RED, Color.BLUE, 10, 0));
    layout.addView(panel);
    TvStyle.refreshAppearance(layout, appearance.context);
    assertEquals(0xffe9eef6, label.getCurrentTextColor());
    assertEquals(TvStyle.dp(activity, 19), ((GradientDrawable) panel.getBackground()).getCornerRadius(), .01f);
    activity.finish();
  }

  @Test
  public void glassPickerDoesNotDimTheRoom() {
    Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
    activity.getSharedPreferences("native-room", Activity.MODE_PRIVATE).edit()
        .putString("appearance-style", "sunny").putString("appearance-material", "glass").apply();
    new TvAppearance(activity).show(activity, () -> {});
    AlertDialog dialog = ShadowAlertDialog.getLatestAlertDialog();
    assertNotNull(dialog);
    assertEquals(0, dialog.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_DIM_BEHIND);
    dialog.dismiss();
    activity.finish();
  }
}
