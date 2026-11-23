package home.haohaochang.tv;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

public final class UpdateProvider extends ContentProvider {
  static final String APK_MIME = "application/vnd.android.package-archive";

  static File directory(Context context) {
    return new File(context.getCacheDir(), "updates");
  }

  @Override
  public boolean onCreate() {
    return true;
  }

  private File file(Uri uri) {
    String path = uri.getEncodedPath();
    if (path == null || !path.matches("/update-[a-f0-9]{64}\\.apk"))
      throw new SecurityException("Unknown file");
    return new File(directory(getContext()), path.substring(1));
  }

  @Override
  public String getType(Uri uri) {
    file(uri);
    return APK_MIME;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"r".equals(mode)) throw new SecurityException("Read only");
    return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
    File apk = file(uri);
    String[] columns = projection == null
        ? new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
    MatrixCursor cursor = new MatrixCursor(columns);
    Object[] values = new Object[columns.length];
    for (int i = 0; i < columns.length; i++) {
      if (OpenableColumns.SIZE.equals(columns[i])) values[i] = apk.length();
      else if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) values[i] = "haohaochang-tv.apk";
    }
    cursor.addRow(values);
    return cursor;
  }

  @Override
  public Uri insert(Uri uri, ContentValues values) {
    throw new UnsupportedOperationException();
  }

  @Override
  public int delete(Uri uri, String selection, String[] args) {
    throw new UnsupportedOperationException();
  }

  @Override
  public int update(Uri uri, ContentValues values, String selection, String[] args) {
    throw new UnsupportedOperationException();
  }
}
