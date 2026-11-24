package home.haohaochang.tv;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

final class TvStyle {
  static final int BACKGROUND = 0xff12101b,
      PANEL = 0xff191623,
      SURFACE = 0xff252031,
      INK = 0xfff5f2ff,
      MUTED = 0xffa7a1bb,
      ACCENT = 0xffc3b2ff,
      PURPLE = 0xff6558db,
      BORDER = 0xff393244;

  static int dp(Context context, float n) {
    return Math.round(n * context.getResources().getDisplayMetrics().density);
  }

  static GradientDrawable shape(Context c, int color, int radius) {
    GradientDrawable d = new GradientDrawable();
    d.setColor(color);
    d.setCornerRadius(dp(c, radius));
    return d;
  }

  static GradientDrawable surface(Context c, int top, int bottom, int radius, int edge) {
    GradientDrawable d = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[] {top, bottom});
    d.setCornerRadius(dp(c, radius));
    if (edge != 0) d.setStroke(dp(c, 1), edge);
    return d;
  }

  static GradientDrawable panel(Context c) {
    return surface(c, 0xff211a30, 0xff15121e, 0, 0);
  }

  static GradientDrawable footer(Context c) {
    return surface(c, 0xff2a2238, 0xff181420, 0, 0x16f3eaff);
  }

  static StateListDrawable card(Context c) {
    StateListDrawable d = new StateListDrawable();
    GradientDrawable focused = surface(c, 0xff4a3c63, 0xff30263e, 12, 0);
    focused.setStroke(dp(c, 2), 0xffc9b3f8);
    d.addState(new int[] {android.R.attr.state_activated}, focused);
    d.addState(new int[] {android.R.attr.state_focused}, focused);
    d.addState(new int[] {android.R.attr.state_pressed}, surface(c, 0xff443651, 0xff302539, 12, 0x60e4d2ff));
    d.addState(new int[] {}, surface(c, 0xff30283c, 0xff211b2b, 12, 0x20efe3ff));
    return d;
  }

  static StateListDrawable photoCardOutline(Context c) {
    StateListDrawable states = new StateListDrawable();
    GradientDrawable focused = shape(c, Color.TRANSPARENT, 12);
    focused.setStroke(dp(c, 2), 0xffe1c8ff);
    states.addState(new int[] {android.R.attr.state_activated}, focused);
    states.addState(new int[] {android.R.attr.state_focused}, focused);
    states.addState(new int[] {android.R.attr.state_pressed}, focused);
    GradientDrawable normal = shape(c, Color.TRANSPARENT, 12);
    normal.setStroke(dp(c, 1), 0x20efe3ff);
    states.addState(new int[] {}, normal);
    return states;
  }

  static StateListDrawable focus(Context c) {
    StateListDrawable d = new StateListDrawable();
    GradientDrawable focused = surface(c, 0xff4b3b64, 0xff33283e, 10, 0);
    focused.setStroke(dp(c, 2), 0xffe1c8ff);
    d.addState(new int[] {android.R.attr.state_focused}, focused);
    d.addState(new int[] {android.R.attr.state_activated}, focused);
    d.addState(new int[] {android.R.attr.state_pressed}, surface(c, 0xffdfd0ff, 0xffb7a2e6, 10, 0x40ffffff));
    d.addState(new int[] {android.R.attr.state_selected}, surface(c, 0xffd4c1fa, 0xffb3a0dc, 10, 0x50ffffff));
    GradientDrawable normal = surface(c, 0xff2d2539, 0xff211b2c, 10, 0x24eee1ff);
    d.addState(new int[] {}, normal);
    return d;
  }

  static ColorStateList ink() {
    return new ColorStateList(
        new int[][] {
          new int[] {-android.R.attr.state_enabled},
          new int[] {android.R.attr.state_focused},
          new int[] {android.R.attr.state_activated},
          new int[] {android.R.attr.state_pressed},
          new int[] {android.R.attr.state_selected},
          new int[] {}
        },
        new int[] {0xff766a84, INK, INK, BACKGROUND, BACKGROUND, INK});
  }

  static TextView text(Context c, String value, int size, int color) {
    TextView v = new TextView(c);
    v.setText(value);
    v.setTextSize(size);
    v.setTextColor(color);
    return v;
  }

  static Button button(Context c, String text, String label, Runnable action) {
    Button b = new TouchButton(c);
    b.setId(View.generateViewId());
    b.setText(text);
    b.setContentDescription(label);
    b.setAllCaps(false);
    b.setFocusable(true);
    b.setFocusableInTouchMode((c.getResources().getConfiguration().uiMode
        & android.content.res.Configuration.UI_MODE_TYPE_MASK)
        == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION);
    b.setTextSize(14);
    b.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
    b.setGravity(Gravity.CENTER);
    b.setTextColor(ink());
    b.setBackground(focus(c));
    b.setMinWidth(0);
    b.setMinimumWidth(0);
    b.setMinHeight(0);
    b.setMinimumHeight(0);
    b.setPadding(dp(c, 6), dp(c, 4), dp(c, 6), dp(c, 4));
    b.setStateListAnimator(null);
    b.setOnClickListener(v -> action.run());
    return b;
  }

  static void icon(Button button, String name) {
    if (button instanceof TouchButton) ((TouchButton) button).sideIcon = name;
    TvIcon icon = new TvIcon(button.getContext(), name, ink(), 19);
    button.setCompoundDrawablesRelative(icon, null, null, null);
    button.setCompoundDrawablePadding(dp(button.getContext(), 7));
  }

  static void restoreSideIcon(Button button) {
    if (button instanceof TouchButton && ((TouchButton) button).sideIcon != null)
      icon(button, ((TouchButton) button).sideIcon);
  }

  static void phoneTab(Button button) {
    Context c = button.getContext();
    StateListDrawable states = new StateListDrawable();
    states.addState(new int[] {android.R.attr.state_selected}, surface(c, 0xff4b3d62, 0xff332840, 8, 0x30ead7ff));
    states.addState(new int[] {android.R.attr.state_pressed}, surface(c, 0xff5b4778, 0xff40304f, 8, 0x40ead7ff));
    states.addState(new int[] {}, shape(c, Color.TRANSPARENT, 6));
    button.setBackground(states);
  }

  static void primary(Button button) {
    Context c = button.getContext();
    StateListDrawable states = new StateListDrawable();
    GradientDrawable focused = surface(c, 0xff9b80ef, 0xff6750c4, 24, 0);
    focused.setStroke(dp(c, 3), 0xffe1c8ff);
    states.addState(new int[] {android.R.attr.state_focused}, focused);
    states.addState(new int[] {android.R.attr.state_pressed}, surface(c, 0xffb79dff, 0xff7b62d8, 24, 0x55ffffff));
    states.addState(new int[] {}, surface(c, 0xff9a7deb, 0xff6550c4, 24, 0x40efe3ff));
    button.setBackground(states);
    button.setElevation(dp(c, 3));
    button.setTextColor(Color.WHITE);
  }

  static void subtle(Button button) {
    Context c = button.getContext();
    StateListDrawable states = new StateListDrawable();
    GradientDrawable focused = shape(c, 0x224d3b68, 8);
    focused.setStroke(dp(c, 2), 0xffe1c8ff);
    states.addState(new int[] {android.R.attr.state_focused}, focused);
    states.addState(new int[] {android.R.attr.state_pressed}, shape(c, 0xff453957, 8));
    states.addState(new int[] {}, shape(c, Color.TRANSPARENT, 8));
    button.setBackground(states);
    button.setTextColor(INK);
  }

  /** Direct touch gets a short response; D-pad navigation remains immediate. */
  private static final class TouchButton extends Button {
    String sideIcon;
    TouchButton(Context context) { super(context); }

    @Override public boolean onTouchEvent(android.view.MotionEvent event) {
      int action = event.getActionMasked();
      if (isEnabled() && (action == android.view.MotionEvent.ACTION_DOWN
          || action == android.view.MotionEvent.ACTION_UP || action == android.view.MotionEvent.ACTION_CANCEL)) {
        boolean motion = android.provider.Settings.Global.getFloat(
            getContext().getContentResolver(), android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0;
        animate().cancel();
        float scale = motion && action == android.view.MotionEvent.ACTION_DOWN ? .97f : 1f;
        animate().scaleX(scale).scaleY(scale).setDuration(motion ? 120 : 0)
            .setInterpolator(new android.view.animation.PathInterpolator(.23f, 1f, .32f, 1f)).start();
      }
      return super.onTouchEvent(event);
    }

    @Override protected void onDetachedFromWindow() {
      animate().cancel();
      setScaleX(1); setScaleY(1);
      super.onDetachedFromWindow();
    }
  }

  static void iconOnly(Button button, String name) {
    subtle(button);
    glyph(button, name, false);
  }

  static void glyph(Button button, String name, boolean primary) {
    button.setText("");
    button.setCompoundDrawables(null, null, null, null);
    ColorStateList colors =
        new ColorStateList(
            new int[][] {
              new int[] {-android.R.attr.state_enabled},
              new int[] {android.R.attr.state_focused},
              new int[] {android.R.attr.state_selected},
              new int[] {}
            },
            new int[] {0xff625c72, Color.WHITE, ACCENT, primary ? Color.WHITE : 0xffc4bbd5});
    button.setForeground(new TvIcon(button.getContext(), name, colors, primary ? 21 : 20));
    button.setForegroundGravity(Gravity.CENTER);
  }
}
