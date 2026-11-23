package home.haohaochang.tv;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
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
    return new Surface(c, color, color, radius, 0, true);
  }

  static GradientDrawable surface(Context c, int top, int bottom, int radius, int edge) {
    return new Surface(c, top, bottom, radius, edge, false);
  }

  private static final class Surface extends GradientDrawable {
    private final int top, bottom, radius, edge;
    private final boolean solid;
    private final Bitmap texture;
    private final Path outline;
    private final Paint texturePaint;
    private final int pixelRadius;
    private boolean overrideFill;

    Surface(Context c, int top, int bottom, int radius, int edge, boolean solid) {
      super(Orientation.TL_BR, new int[] {top, bottom});
      this.top = top;
      this.bottom = bottom;
      this.radius = radius;
      this.edge = edge;
      this.solid = solid;
      TvAppearance appearance = TvAppearance.of(c);
      boolean hasFill = top != Color.TRANSPARENT || bottom != Color.TRANSPARENT;
      texture = appearance == null || !hasFill ? null : appearance.texture();
      outline = texture == null ? null : new Path();
      texturePaint = texture == null ? null : new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
      pixelRadius = dp(c, appearance == null ? radius : appearance.radius(radius));
      setCornerRadius(pixelRadius);
      if (appearance == null) {
        if (solid) setColor(top);
        if (edge != 0) setStroke(dp(c, 1), edge);
      } else {
        if (hasFill) setColors(appearance.fill());
        else setColor(Color.TRANSPARENT);
        if (edge != 0) setStroke(dp(c, 1), appearance.materialEdge());
      }
    }

    Drawable restyle(Context c) { return new Surface(c, top, bottom, radius, edge, solid); }

    @Override public void setColor(int color) {
      overrideFill = true;
      super.setColor(color);
    }

    @Override protected void onBoundsChange(Rect bounds) {
      super.onBoundsChange(bounds);
      if (outline == null) return;
      outline.reset();
      outline.addRoundRect(new RectF(bounds), pixelRadius, pixelRadius, Path.Direction.CW);
    }

    @Override public void draw(Canvas canvas) {
      super.draw(canvas);
      if (texture == null || overrideFill) return;
      int save = canvas.save();
      canvas.clipPath(outline);
      texturePaint.setAlpha(getAlpha());
      canvas.drawBitmap(texture, null, getBounds(), texturePaint);
      canvas.restoreToCount(save);
    }
  }

  private enum Role { CARD, PHOTO, NORMAL, COMPACT, PRIMARY, SUBTLE }

  private static final class ButtonSurface extends StateListDrawable {
    final Role role;
    ButtonSurface(Role role) { this.role = role; }
  }

  private static StateListDrawable themed(Context c, Role role, TvAppearance appearance) {
    StateListDrawable states = new ButtonSurface(role);
    int radius = role == Role.PRIMARY ? 24 : role == Role.CARD || role == Role.PHOTO ? 12 : 10;
    int accent = appearance.accent();
    boolean transparent = role == Role.SUBTLE || role == Role.PHOTO || role == Role.COMPACT;
    GradientDrawable focused = shape(c, Color.TRANSPARENT, radius);
    if (role != Role.PHOTO) focused.setColor(TvAppearance.blend(appearance.fill()[0], accent, .16f));
    focused.setStroke(dp(c, 2), accent);
    states.addState(new int[] {android.R.attr.state_focused}, focused);
    states.addState(new int[] {android.R.attr.state_activated}, focused);
    GradientDrawable selected = shape(c, Color.TRANSPARENT, radius);
    if (role != Role.PHOTO) selected.setColor(accent);
    selected.setStroke(dp(c, 1), accent);
    states.addState(new int[] {android.R.attr.state_selected}, selected);
    states.addState(new int[] {android.R.attr.state_pressed}, selected);
    GradientDrawable normal = shape(c, transparent ? Color.TRANSPARENT : SURFACE, radius);
    if (role == Role.PRIMARY) normal.setColor(accent);
    else if (!transparent || role == Role.PHOTO) normal.setStroke(dp(c, 1), appearance.materialEdge());
    states.addState(new int[] {}, normal);
    return states;
  }

  static GradientDrawable panel(Context c) {
    return surface(c, 0xff211a30, 0xff15121e, 0, 0);
  }

  static GradientDrawable footer(Context c) {
    return surface(c, 0xff2a2238, 0xff181420, 0, 0x16f3eaff);
  }

  static StateListDrawable card(Context c) {
    TvAppearance appearance = TvAppearance.of(c);
    if (appearance != null) return themed(c, Role.CARD, appearance);
    StateListDrawable d = new ButtonSurface(Role.CARD);
    GradientDrawable focused = surface(c, 0xff4a3c63, 0xff30263e, 12, 0);
    focused.setStroke(dp(c, 2), 0xffc9b3f8);
    d.addState(new int[] {android.R.attr.state_activated}, focused);
    d.addState(new int[] {android.R.attr.state_focused}, focused);
    d.addState(new int[] {android.R.attr.state_pressed}, surface(c, 0xff443651, 0xff302539, 12, 0x60e4d2ff));
    d.addState(new int[] {}, surface(c, 0xff30283c, 0xff211b2b, 12, 0x20efe3ff));
    return d;
  }

  static StateListDrawable photoCardOutline(Context c) {
    TvAppearance appearance = TvAppearance.of(c);
    if (appearance != null) return themed(c, Role.PHOTO, appearance);
    StateListDrawable states = new ButtonSurface(Role.PHOTO);
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
    TvAppearance appearance = TvAppearance.of(c);
    if (appearance != null) return themed(c, Role.NORMAL, appearance);
    StateListDrawable d = new ButtonSurface(Role.NORMAL);
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
    return buttonInk(null, false);
  }

  private static ColorStateList buttonInk(TvAppearance appearance, boolean primary) {
    int text = appearance == null ? INK : appearance.ink();
    int selected = appearance == null ? BACKGROUND : appearance.accentInk();
    int disabled = appearance == null ? 0xff766a84 : appearance.muted();
    if (primary) text = appearance == null ? Color.WHITE : selected;
    return new ColorStateList(
        new int[][] {
          new int[] {-android.R.attr.state_enabled},
          new int[] {android.R.attr.state_focused},
          new int[] {android.R.attr.state_activated},
          new int[] {android.R.attr.state_pressed},
          new int[] {android.R.attr.state_selected},
          new int[] {}
        },
        new int[] {disabled, appearance == null && primary ? Color.WHITE : appearance == null ? INK : appearance.ink(),
          text, selected, selected, text});
  }

  static TextView text(Context c, String value, int size, int color) {
    TextView v = new TextView(c);
    v.setText(value);
    v.setTextSize(size);
    textColor(v, color);
    return v;
  }

  static void textColor(TextView view, int color) {
    view.setTag(R.id.appearance_text_color, color);
    view.setTextColor(color(view.getContext(), color));
  }

  static int color(Context c, int original) {
    TvAppearance appearance = TvAppearance.of(c);
    if (appearance == null) return original;
    switch (original) {
      case BACKGROUND: return appearance.page();
      case MUTED: return appearance.muted();
      case ACCENT: return appearance.accent();
      case INK: return appearance.ink();
      default: return original;
    }
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
    b.setTextColor(buttonInk(TvAppearance.of(c), false));
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
    TvIcon icon = new TvIcon(button.getContext(), name, buttonInk(TvAppearance.of(button.getContext()), false), 19);
    button.setCompoundDrawablesRelative(icon, null, null, null);
    button.setCompoundDrawablePadding(dp(button.getContext(), 7));
  }

  static void phoneTab(Button button) {
    Context c = button.getContext();
    TvAppearance appearance = TvAppearance.of(c);
    if (appearance != null) {
      button.setBackground(themed(c, Role.COMPACT, appearance));
      button.setTextColor(buttonInk(appearance, false));
      return;
    }
    StateListDrawable states = new ButtonSurface(Role.COMPACT);
    states.addState(new int[] {android.R.attr.state_selected}, surface(c, 0xff4b3d62, 0xff332840, 8, 0x30ead7ff));
    states.addState(new int[] {android.R.attr.state_pressed}, surface(c, 0xff5b4778, 0xff40304f, 8, 0x40ead7ff));
    states.addState(new int[] {}, shape(c, Color.TRANSPARENT, 6));
    button.setBackground(states);
  }

  static void primary(Button button) {
    Context c = button.getContext();
    TvAppearance appearance = TvAppearance.of(c);
    if (appearance != null) {
      button.setBackground(themed(c, Role.PRIMARY, appearance));
      button.setElevation(dp(c, 3));
      button.setTextColor(buttonInk(appearance, true));
      return;
    }
    StateListDrawable states = new ButtonSurface(Role.PRIMARY);
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
    TvAppearance appearance = TvAppearance.of(c);
    if (appearance != null) {
      button.setBackground(themed(c, Role.SUBTLE, appearance));
      button.setTextColor(buttonInk(appearance, false));
      return;
    }
    StateListDrawable states = new ButtonSurface(Role.SUBTLE);
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
    String sideIcon, glyph;
    boolean primaryGlyph;
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
    if (button instanceof TouchButton) {
      TouchButton themed = (TouchButton) button;
      themed.glyph = name;
      themed.primaryGlyph = primary;
    }
    button.setText("");
    button.setCompoundDrawables(null, null, null, null);
    TvAppearance appearance = TvAppearance.of(button.getContext());
    ColorStateList colors =
        new ColorStateList(
            new int[][] {
              new int[] {-android.R.attr.state_enabled},
              new int[] {android.R.attr.state_focused},
              new int[] {android.R.attr.state_selected},
              new int[] {}
            },
            appearance == null
                ? new int[] {0xff625c72, Color.WHITE, ACCENT, primary ? Color.WHITE : 0xffc4bbd5}
                : new int[] {appearance.muted(), appearance.ink(), appearance.accentInk(),
                    primary ? appearance.accentInk() : appearance.ink()});
    button.setForeground(new TvIcon(button.getContext(), name, colors, primary ? 21 : 20));
    button.setForegroundGravity(Gravity.CENTER);
  }

  static void normal(Button button) {
    button.setBackground(focus(button.getContext()));
    button.setTextColor(buttonInk(TvAppearance.of(button.getContext()), false));
  }

  static void restoreSideIcon(Button button) {
    if (button instanceof TouchButton && ((TouchButton) button).sideIcon != null)
      icon(button, ((TouchButton) button).sideIcon);
  }

  static void refreshAppearance(View view, Context skin) {
    Drawable background = view.getBackground();
    if (background instanceof Surface) view.setBackground(((Surface) background).restyle(skin));
    if (view instanceof TouchButton && background instanceof ButtonSurface) {
      TouchButton button = (TouchButton) view;
      Role role = ((ButtonSurface) background).role;
      switch (role) {
        case PRIMARY: primary(button); break;
        case SUBTLE: subtle(button); break;
        case COMPACT:
          button.setTextColor(color(skin, INK));
          phoneTab(button);
          break;
        default: normal(button); break;
      }
      if (button.glyph != null) glyph(button, button.glyph, button.primaryGlyph);
      else if (button.sideIcon != null && role != Role.COMPACT) icon(button, button.sideIcon);
    } else {
      if (background instanceof ButtonSurface) {
        Role role = ((ButtonSurface) background).role;
        view.setBackground(role == Role.CARD ? card(skin) : focus(skin));
      }
      if (view.getForeground() instanceof ButtonSurface) view.setForeground(photoCardOutline(skin));
      if (view instanceof TextView) {
        Object original = view.getTag(R.id.appearance_text_color);
        if (original instanceof Integer)
          ((TextView) view).setTextColor(color(view.getContext(), (Integer) original));
        if (view instanceof EditText) ((EditText) view).setHintTextColor(color(skin, MUTED));
      }
    }
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) refreshAppearance(group.getChildAt(i), skin);
    }
  }
}
