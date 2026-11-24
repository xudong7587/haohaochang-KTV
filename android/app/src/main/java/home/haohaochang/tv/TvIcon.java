package home.haohaochang.tv;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;

/** Small vector icons matching the original TV interface, independent of installed symbol fonts. */
final class TvIcon extends Drawable {
  private final String name;
  private final ColorStateList colors;
  private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final int size;

  TvIcon(Context context, String name, ColorStateList colors, int dp) {
    this.name = name;
    this.colors = colors;
    size = TvStyle.dp(context, dp);
    setBounds(0, 0, size, size);
    paint.setStrokeWidth(1.7f);
    paint.setStrokeCap(Paint.Cap.ROUND);
    paint.setStrokeJoin(Paint.Join.ROUND);
    paint.setStyle(Paint.Style.STROKE);
  }

  @Override
  public void draw(Canvas canvas) {
    canvas.save();
    float edge = Math.min(size, Math.min(getBounds().width(), getBounds().height()));
    canvas.translate(getBounds().exactCenterX() - edge / 2, getBounds().exactCenterY() - edge / 2);
    canvas.scale(edge / 24f, edge / 24f);
    paint.setColor(colors.getColorForState(getState(), colors.getDefaultColor()));
    switch (name) {
      case "sort":
        line(canvas, 4, 6, 20, 6);
        line(canvas, 7, 12, 17, 12);
        line(canvas, 10, 18, 14, 18);
        break;
      case "trash":
        line(canvas, 4, 6, 20, 6);
        path(canvas, 9, 6, 9, 3, 15, 3, 15, 6);
        path(canvas, 6, 6, 7, 21, 17, 21, 18, 6);
        line(canvas, 10, 10, 10, 17);
        line(canvas, 14, 10, 14, 17);
        break;
      case "reset":
        canvas.drawArc(4, 4, 20, 20, -140, 295, false, paint);
        path(canvas, 3, 3, 3, 9, 9, 9);
        break;
      case "play":
        path(canvas, 7, 4, 20, 12, 7, 20, 7, 4);
        break;
      case "pause":
        line(canvas, 8, 5, 8, 19);
        line(canvas, 16, 5, 16, 19);
        break;
      case "next":
        path(canvas, 5, 5, 16, 12, 5, 19, 5, 5);
        line(canvas, 20, 5, 20, 19);
        break;
      case "mic":
        canvas.drawRoundRect(9, 2, 15, 15, 3, 3, paint);
        canvas.drawArc(5, 6, 19, 19, 0, 180, false, paint);
        line(canvas, 12, 19, 12, 22);
        line(canvas, 8, 22, 16, 22);
        break;
      case "users":
        canvas.drawCircle(9, 7, 3, paint);
        canvas.drawArc(2, 12, 16, 24, 180, 180, false, paint);
        canvas.drawArc(13, 4, 20, 10, -90, 180, false, paint);
        canvas.drawArc(13, 12, 22, 24, 270, 90, false, paint);
        break;
      case "list":
        line(canvas, 3, 5, 15, 5);
        line(canvas, 3, 10, 15, 10);
        line(canvas, 3, 15, 10, 15);
        line(canvas, 19, 9, 19, 19);
        canvas.drawOval(13, 16, 19, 21, paint);
        break;
      case "globe":
        canvas.drawCircle(12, 12, 9, paint);
        canvas.drawOval(8, 3, 16, 21, paint);
        line(canvas, 3, 12, 21, 12);
        break;
      case "screen":
        canvas.drawRoundRect(2, 4, 22, 18, 2, 2, paint);
        line(canvas, 8, 22, 16, 22);
        break;
      case "exit":
        path(canvas, 3, 8, 8, 8, 8, 3);
        path(canvas, 16, 3, 16, 8, 21, 8);
        path(canvas, 3, 16, 8, 16, 8, 21);
        path(canvas, 16, 21, 16, 16, 21, 16);
        break;
      case "lyrics":
        canvas.drawRoundRect(2, 4, 22, 20, 2, 2, paint);
        line(canvas, 6, 10, 18, 10);
        line(canvas, 6, 15, 14, 15);
        break;
      case "search":
        canvas.drawCircle(10, 10, 7, paint);
        line(canvas, 15, 15, 21, 21);
        break;
      case "qr":
        canvas.drawRect(3, 3, 9, 9, paint);
        canvas.drawRect(15, 3, 21, 9, paint);
        canvas.drawRect(3, 15, 9, 21, paint);
        path(canvas, 15, 15, 21, 15, 21, 21, 17, 21, 17, 18);
        break;
      case "settings":
        for (int x : new int[] {5, 12, 19}) line(canvas, x, 3, x, 21);
        canvas.drawCircle(5, 8, 2, paint);
        canvas.drawCircle(12, 16, 2, paint);
        canvas.drawCircle(19, 9, 2, paint);
        break;
      case "record":
        canvas.drawCircle(12, 12, 9, paint);
        canvas.drawCircle(12, 12, 2, paint);
        canvas.drawArc(6, 6, 18, 18, 190, 50, false, paint);
        canvas.drawArc(6, 6, 18, 18, 10, 50, false, paint);
        break;
      default:
        path(canvas, 10, 18, 10, 4, 20, 2, 20, 16);
        canvas.drawOval(4, 15, 10, 21, paint);
        canvas.drawOval(14, 13, 20, 19, paint);
        break;
    }
    canvas.restore();
  }

  private void line(Canvas c, float a, float b, float x, float y) {
    c.drawLine(a, b, x, y, paint);
  }

  private void path(Canvas c, float... points) {
    Path p = new Path();
    p.moveTo(points[0], points[1]);
    for (int i = 2; i < points.length; i += 2) p.lineTo(points[i], points[i + 1]);
    c.drawPath(p, paint);
  }

  @Override
  public boolean isStateful() {
    return colors.isStateful();
  }

  @Override
  protected boolean onStateChange(int[] state) {
    invalidateSelf();
    return true;
  }

  @Override
  public int getIntrinsicWidth() {
    return size;
  }

  @Override
  public int getIntrinsicHeight() {
    return size;
  }

  @Override
  public void setAlpha(int alpha) {
    paint.setAlpha(alpha);
  }

  @Override
  public void setColorFilter(ColorFilter filter) {
    paint.setColorFilter(filter);
  }

  @Override
  public int getOpacity() {
    return PixelFormat.TRANSLUCENT;
  }
}
