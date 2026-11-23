package home.haohaochang.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.view.WindowManager;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** SunnyUI preferences and lightweight native surfaces for Android TV. */
final class TvAppearance {
  private static final String PREFIX = "appearance-";
  private final SharedPreferences preferences;
  private final JSONObject catalogue;
  final Context context;
  boolean active, dark;
  private String material;
  private int accent, accent2, accent3, glassOpacity;
  private float corners;
  private int textureId;
  private Bitmap texture;

  TvAppearance(Activity activity) {
    preferences = activity.getSharedPreferences("native-room", Activity.MODE_PRIVATE);
    context = new SkinContext(activity, this);
    try (InputStream input = activity.getAssets().open("sunny-appearance.json")) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[4096];
      for (int count; (count = input.read(buffer)) != -1; ) bytes.write(buffer, 0, count);
      catalogue = new JSONObject(bytes.toString("UTF-8"));
    } catch (IOException | JSONException error) {
      throw new IllegalStateException("Missing bundled appearance catalogue", error);
    }
    load();
  }

  static TvAppearance of(Context context) {
    if (context instanceof SkinContext) {
      TvAppearance appearance = ((SkinContext) context).appearance;
      if (appearance.active) return appearance;
    }
    return null;
  }

  private static final class SkinContext extends ContextWrapper {
    final TvAppearance appearance;

    SkinContext(Context base, TvAppearance appearance) {
      super(base);
      this.appearance = appearance;
    }
  }

  private String preference(String key, String fallback) {
    return preferences.getString(PREFIX + key, fallback);
  }

  private JSONObject option(String key, String id) {
    JSONArray items = catalogue.optJSONArray(key);
    for (int i = 0; i < items.length(); i++) {
      JSONObject item = items.optJSONObject(i);
      if (item.optString("id").equals(id)) return item;
    }
    return items.optJSONObject(0);
  }

  private void load() {
    active = preference("style", "classic").equals("sunny");
    String theme = preference("theme", "light");
    material = option("materials", preference("material", "soft")).optString("id");
    dark = theme.equals("dark") || material.equals("neon");
    JSONObject palette = option("colors", preference("color", "blue"));
    String tone = dark ? "dark" : "light";
    JSONArray colors = palette.optJSONArray(tone);
    accent = Color.parseColor(colors == null ? palette.optString(tone) : colors.optString(0));
    accent2 = colors == null ? blend(accent, dark ? 0xff84d8dc : 0xff238c92, .55f) : Color.parseColor(colors.optString(1));
    accent3 = colors == null ? blend(accent, dark ? 0xffe4b2f0 : 0xff8756bd, .55f) : Color.parseColor(colors.optString(2));
    corners = (float) option("corners", preference("corner", "default")).optDouble("scale", 1);
    glassOpacity = Math.max(0, Math.min(100, preferences.getInt(PREFIX + "glass-opacity", 11)));
    int requestedTexture = active ? materialTextureId() : 0;
    if (textureId != requestedTexture) {
      textureId = requestedTexture;
      texture = textureId == 0 ? null : BitmapFactory.decodeResource(context.getResources(), textureId);
    }
  }

  private void select(String key, String value, Runnable changed) {
    preferences.edit().putString(PREFIX + key, value).apply();
    load();
    changed.run();
  }

  void show(Activity activity, Runnable changed) {
    List<String> names = new ArrayList<>(Arrays.asList(
        active ? new String[] {"好好唱默认", "SunnyUI ✓", "明暗", "质感", "配色", "圆角"}
            : new String[] {"好好唱默认 ✓", "SunnyUI"}));
    if (active && glass()) names.add("玻璃不透明度");
    showDialog(dialog(activity, "画面风格").setItems(names.toArray(new String[0]), (dialog, index) -> {
      switch (index) {
        case 0: select("style", "classic", changed); break;
        case 1:
          select("style", "sunny", changed);
          show(activity, changed);
          break;
        case 2:
          showDialog(dialog(activity, "明暗").setSingleChoiceItems(new String[] {"浅色", "深色"},
              preference("theme", "light").equals("dark") ? 1 : 0, (picker, choice) -> {
                select("theme", choice == 0 ? "light" : "dark", changed);
                picker.dismiss();
              }).setNegativeButton("关闭", null));
          break;
        case 3: choose(activity, "质感", "material", "materials", "soft", changed); break;
        case 4: choose(activity, "配色", "color", "colors", "blue", changed); break;
        case 5: choose(activity, "圆角", "corner", "corners", "default", changed); break;
        case 6: opacity(activity, changed); break;
        default: break;
      }
    }).setNegativeButton("关闭", null));
  }

  private boolean glass() {
    return material.equals("glass") || material.equals("frosted") || material.equals("aurora");
  }

  private void showDialog(AlertDialog.Builder builder) {
    AlertDialog dialog = builder.show();
    if (active && glass() && dialog.getWindow() != null)
      dialog.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
  }

  private AlertDialog.Builder dialog(Activity activity, String title) {
    return new AlertDialog.Builder(activity, active && !dark
        ? android.R.style.Theme_Material_Light_Dialog_Alert
        : android.R.style.Theme_Material_Dialog_Alert).setTitle(title);
  }

  private void choose(Activity activity, String title, String key, String list,
      String fallback, Runnable changed) {
    JSONArray options = catalogue.optJSONArray(list);
    String[] names = new String[options.length()];
    int selected = 0;
    for (int i = 0; i < names.length; i++) {
      JSONObject item = options.optJSONObject(i);
      names[i] = item.optString("name");
      if (item.optString("id").equals(preference(key, fallback))) selected = i;
    }
    showDialog(dialog(activity, title).setSingleChoiceItems(names, selected, (picker, index) -> {
      select(key, options.optJSONObject(index).optString("id"), changed);
      picker.dismiss();
    }).setNegativeButton("关闭", null));
  }

  private void opacity(Activity activity, Runnable changed) {
    android.widget.LinearLayout box = new android.widget.LinearLayout(context);
    box.setOrientation(android.widget.LinearLayout.VERTICAL);
    int inset = TvStyle.dp(context, 24);
    box.setPadding(inset, 0, inset, 0);
    android.widget.TextView value = TvStyle.text(context, glassOpacity + "%", 16, TvStyle.INK);
    box.addView(value);
    android.widget.SeekBar slider = new android.widget.SeekBar(context);
    slider.setMax(100);
    slider.setProgress(glassOpacity);
    slider.setKeyProgressIncrement(1);
    slider.setContentDescription("玻璃不透明度");
    box.addView(slider);
    slider.setOnSeekBarChangeListener(new android.widget.SeekBar.OnSeekBarChangeListener() {
      public void onStartTrackingTouch(android.widget.SeekBar bar) {}
      public void onStopTrackingTouch(android.widget.SeekBar bar) {}
      public void onProgressChanged(android.widget.SeekBar bar, int progress, boolean fromUser) {
        if (!fromUser) return;
        value.setText(progress + "%");
        glassOpacity = progress;
        preferences.edit().putInt(PREFIX + "glass-opacity", progress).apply();
        changed.run();
      }
    });
    showDialog(dialog(activity, "玻璃不透明度").setView(box).setPositiveButton("完成", null));
  }

  int ink() { return dark ? 0xffe9eef6 : 0xff18212e; }
  int muted() { return dark ? 0xffadb9c9 : 0xff526173; }
  int accent() { return accent; }
  int accentInk() { return dark ? 0xff10151e : Color.WHITE; }
  int page() { return dark ? 0xff12171f : 0xffeceff4; }
  int edge() { return dark ? 0xff3a4757 : 0xffcbd5e4; }
  int radius(int original) { return Math.round(original * corners); }
  Bitmap texture() { return texture; }

  private int materialTextureId() {
    // The three faces are the SunnyUI 2.2 static textures rasterized for Android.
    switch (material) {
      case "linen": return dark ? R.drawable.sunny_linen_dark : R.drawable.sunny_linen_light;
      case "metal": return dark ? R.drawable.sunny_metal_dark : R.drawable.sunny_metal_light;
      case "marble": return dark ? R.drawable.sunny_marble_dark : R.drawable.sunny_marble_light;
      default: return 0;
    }
  }

  int[] fill() {
    int base = dark ? 0xff1a212b : 0xfff7f8fb;
    switch (material) {
      case "clear": return new int[] {base, base};
      case "paper": return dark ? new int[] {0xff38332b, 0xff242119} : new int[] {0xfffffdf7, 0xffefe5d1};
      case "linen": return dark ? new int[] {0xff35352f, 0xff212724} : new int[] {0xfff4f1e8, 0xffe8e7dc};
      case "glass": return new int[] {blend(base, Color.WHITE, glassOpacity / 240f), base};
      case "frosted": return new int[] {base, blend(base, page(), glassOpacity / 130f)};
      case "aurora": return new int[] {blend(base, accent, .08f + glassOpacity / 250f), blend(base, accent2, .08f + glassOpacity / 250f)};
      case "duotone": return new int[] {blend(base, accent, .27f), blend(base, accent2, .23f), blend(base, accent3, .15f)};
      case "satin": return new int[] {base, blend(base, accent, .14f), blend(base, Color.WHITE, .19f), base};
      case "metal": return dark ? new int[] {0xff303a48, 0xff495564, 0xff2a333e} : new int[] {0xffc9d2de, 0xfff7faff, 0xffd6dde7};
      case "clay": return dark ? new int[] {0xff3a2a25, 0xff241b19} : new int[] {0xfffbf2e7, 0xffe8d5c3};
      case "marble": return dark ? new int[] {0xff252e3b, 0xff39465a, 0xff283241} : new int[] {0xfff7f9fd, 0xffe6ecf3, 0xfff8fafc};
      case "neon": return new int[] {0xff192136, 0xff0b0f17};
      case "mesh": return new int[] {blend(base, accent2, .22f), blend(base, accent3, .10f), blend(base, accent, .24f)};
      case "outline":
      case "cutout": return new int[] {base, base};
      default: return new int[] {blend(base, accent, .08f), base};
    }
  }

  int materialEdge() {
    switch (material) {
      case "outline":
      case "neon":
      case "cutout": return accent;
      case "linen":
      case "metal":
      case "marble":
      case "clear":
      case "duotone":
      case "mesh": return Color.TRANSPARENT;
      default: return edge();
    }
  }

  static int blend(int a, int b, float t) {
    return Color.rgb(Math.round(Color.red(a) * (1 - t) + Color.red(b) * t),
        Math.round(Color.green(a) * (1 - t) + Color.green(b) * t),
        Math.round(Color.blue(a) * (1 - t) + Color.blue(b) * t));
  }
}
