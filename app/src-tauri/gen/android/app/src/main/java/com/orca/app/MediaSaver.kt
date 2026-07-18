package com.orca.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder

/**
 * Saves a finished download from the Orca server onto the device's shared
 * storage, under `Downloads/Orca` (or `Downloads/.Orca` when "hide my
 * downloads" is on).
 *
 * Why this exists at all: the web UI saves with `<a href download>`, which the
 * browser turns into a file. An Android WebView does NOT — it has no download
 * manager of its own, and Tauri registers no DownloadListener, so the anchor
 * click was swallowed and the Save button did nothing whatsoever in the app.
 * Saving has to be done natively, which is what this object is for.
 *
 * Storage model (this is the part that silently fails if you get it wrong):
 *  - API 30+ writing arbitrary paths in shared storage — and in particular
 *    creating a DOT-PREFIXED directory, which MediaStore refuses outright —
 *    requires MANAGE_EXTERNAL_STORAGE ("All files access"). It is NOT a runtime
 *    dialog: it can only be granted from a Settings screen we send the user to,
 *    and it reports through Environment.isExternalStorageManager().
 *  - API <= 29 predates that and uses the WRITE_EXTERNAL_STORAGE runtime grant.
 * Every write here is gated on [granted] so we surface a real error instead of
 * throwing an opaque EACCES half way through a download.
 */
object MediaSaver {
  const val VISIBLE_DIR = "Orca"
  const val HIDDEN_DIR = ".Orca"

  private const val PREFS = "orca_permissions"
  private const val KEY_HIDDEN = "hide_downloads"

  /**
   * Registry of what we've saved: item slug → the file on disk and its pixel
   * height. Without it the app has no idea a local copy exists — the filenames
   * are server-supplied, de-duplicated (`name (2).mp4`) and sanitized, so
   * matching them back to an item by name is guesswork. One entry per slug: a
   * second save of the same item replaces the first (see [save]).
   */
  private const val PREFS_FILES = "orca_local_files"

  /** A saved copy of one item. [height] is 0 when the server didn't report one. */
  data class Local(val path: String, val height: Int)

  private fun filesPrefs(ctx: Context) =
    ctx.getSharedPreferences(PREFS_FILES, Context.MODE_PRIVATE)

  private fun remember(ctx: Context, slug: String, file: File, height: Int) {
    if (slug.isEmpty()) return
    val json = org.json.JSONObject()
      .put("path", file.absolutePath)
      .put("height", height)
    filesPrefs(ctx).edit().putString(slug, json.toString()).apply()
  }

  fun forget(ctx: Context, slug: String) {
    filesPrefs(ctx).edit().remove(slug).apply()
  }

  /**
   * The local copy of [slug], or null if we never saved it — or saved it and the
   * user has since deleted it from Downloads. The existence check is the point:
   * a registry that can go stale silently would have the player try to open a
   * file that isn't there, which is worse than never having offered local
   * playback. A vanished file forgets itself so the next call is a clean miss.
   */
  fun localFile(ctx: Context, slug: String): Local? {
    val raw = filesPrefs(ctx).getString(slug, null) ?: return null
    val entry = try {
      val o = org.json.JSONObject(raw)
      Local(o.getString("path"), o.optInt("height", 0))
    } catch (_: Exception) {
      forget(ctx, slug); return null
    }
    val f = File(entry.path)
    if (!f.isFile || f.length() == 0L) { forget(ctx, slug); return null }
    return entry
  }

  /**
   * A one-shot listing of the active folder, so a whole page of items is matched
   * against ONE directory read instead of one per item. Sizes come straight from
   * the listing — no file is opened, and nothing is decoded.
   */
  class FolderIndex(dir: File, claimed: Set<String>) {
    /** Every regular file in the folder, keyed by exact byte length. */
    private val bySize: Map<Long, List<File>> =
      (dir.listFiles() ?: emptyArray())
        .filter { it.isFile && it.name != ".nomedia" && !it.name.endsWith(".part") }
        .groupBy { it.length() }

    /**
     * Paths no longer up for adoption — already spoken for by a registry entry,
     * or adopted earlier in this same batch. Without it, two items that happen to
     * be the same byte length (the same video downloaded twice) would both adopt
     * whichever file sorted first, and one card would play the other's video.
     */
    private val taken: MutableSet<String> = claimed.toMutableSet()

    /**
     * The file matching the server's fingerprint for an item, or null.
     *
     * Byte size is the primary key and it is doing the real work: a given render
     * of a given video is one exact length, so a size hit is already the right
     * file — and, crucially, the right RESOLUTION. The server quotes the size of
     * the copy it holds *now*, so a stale 720p save left over from before an
     * upgrade to 1080p simply doesn't match, which is the outcome we want.
     *
     * [want] only breaks ties between two same-length files, and matches loosely
     * because [uniqueFile] may have stored it as `name (2).mp4`. It arrives
     * already sanitized — the caller writes files through the same [sanitize],
     * so comparing raw server names here would never match.
     */
    fun match(want: String, size: Long): File? {
      if (size <= 0L) return null
      val candidates = (bySize[size] ?: return null).filter { it.absolutePath !in taken }
      if (candidates.isEmpty()) return null
      val hit = candidates.firstOrNull { sameStem(it.name, want) }
        ?: candidates.singleOrNull()
        ?: return null // ambiguous: several same-size files, none named like ours
      taken.add(hit.absolutePath)
      return hit
    }

    /** `a.mp4` vs `a.mp4` / `a (2).mp4` — the forms uniqueFile can produce. */
    private fun sameStem(have: String, want: String): Boolean {
      if (have == want) return true
      val ext = want.substringAfterLast('.', "")
      val stem = if (ext.isEmpty()) want else want.dropLast(ext.length + 1)
      return Regex(Regex.escape(stem) + " \\(\\d+\\)" + if (ext.isEmpty()) "" else Regex.escape(".$ext"))
        .matches(have)
    }
  }

  /**
   * The local copy of [slug], recognising files this build never recorded.
   *
   * The registry alone only knows about saves made since it existed, so a folder
   * full of videos from an older build read as "not downloaded" and streamed.
   * When the registry misses, fall back to matching the server's fingerprint
   * (name + exact size) against [index] and adopt the hit — writing it into the
   * registry, so the walk happens once per file rather than on every render.
   */
  fun resolve(ctx: Context, slug: String, name: String, size: Long, height: Int, index: FolderIndex): Local? {
    localFile(ctx, slug)?.let { return it }
    if (slug.isEmpty()) return null
    val found = index.match(sanitize(name), size) ?: return null
    remember(ctx, slug, found, height)
    return Local(found.absolutePath, height)
  }

  /**
   * Delete this device's saved copy of [slug], if there is one, and forget it.
   * Resolves the file the same way playback does — registry first, then a
   * fingerprint match in [index] — so a copy an older build never recorded is
   * still found and removed. The registry entry is dropped regardless (it is
   * stale either way), and the media scanner is told the path is gone. Returns
   * true only when a real file was removed, so a caller can count deletions.
   */
  fun deleteLocal(ctx: Context, slug: String, name: String, size: Long, height: Int, index: FolderIndex): Boolean {
    val local = resolve(ctx, slug, name, size, height, index) ?: return false
    val f = File(local.path)
    val deleted = f.isFile && f.delete()
    forget(ctx, slug)
    if (deleted) rescan(ctx, f)
    return deleted
  }

  /** A folder index for the active save folder, pre-claiming every registered path. */
  fun folderIndex(ctx: Context): FolderIndex {
    val claimed = filesPrefs(ctx).all.values.mapNotNull { raw ->
      try { org.json.JSONObject(raw as String).getString("path") } catch (_: Exception) { null }
    }.toSet()
    return FolderIndex(dir(ctx), claimed)
  }

  /** Re-point registry entries after [setHidden] moves files between folders. */
  private fun rewritePaths(ctx: Context, moves: Map<String, String>) {
    if (moves.isEmpty()) return
    val prefs = filesPrefs(ctx)
    val edit = prefs.edit()
    for ((slug, raw) in prefs.all) {
      val text = raw as? String ?: continue
      try {
        val o = org.json.JSONObject(text)
        val moved = moves[o.getString("path")] ?: continue
        edit.putString(slug, o.put("path", moved).toString())
      } catch (_: Exception) { edit.remove(slug) }
    }
    edit.apply()
  }

  /** True once the app may write our folder in shared storage. */
  fun granted(ctx: Context): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Environment.isExternalStorageManager()
    } else {
      ctx.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
        PackageManager.PERMISSION_GRANTED
    }

  fun isHidden(ctx: Context): Boolean =
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_HIDDEN, false)

  private fun rememberHidden(ctx: Context, hidden: Boolean) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putBoolean(KEY_HIDDEN, hidden).apply()
  }

  /** `Downloads/Orca` or `Downloads/.Orca`, per the current (or given) mode. */
  fun dir(ctx: Context, hidden: Boolean = isHidden(ctx)): File = File(
    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
    if (hidden) HIDDEN_DIR else VISIBLE_DIR,
  )

  /**
   * A dot-directory is already skipped by the media scanner, but a `.nomedia`
   * marker is the documented contract and is what stops a rogue gallery from
   * indexing the folder anyway. Only ever placed in the hidden tree.
   */
  private fun applyNomedia(dir: File, hidden: Boolean) {
    val marker = File(dir, ".nomedia")
    try {
      if (hidden) {
        if (!marker.exists()) marker.createNewFile()
      } else if (marker.exists()) {
        marker.delete()
      }
    } catch (_: Exception) { /* best-effort: never fail a save over the marker */ }
  }

  /**
   * Switch between the visible and hidden folders, MOVING everything already
   * saved so the setting applies retroactively (an "unhide" that stranded old
   * files in `.Orca` would be worse than not offering the toggle). Returns how
   * many files were moved.
   */
  fun setHidden(ctx: Context, hidden: Boolean): Int {
    val from = dir(ctx, !hidden)
    val to = dir(ctx, hidden)
    var moved = 0
    // Old → new absolute path for everything we actually move, so the local-file
    // registry can follow. Rebuilding it from filenames afterwards would not
    // work: uniqueFile may rename on collision.
    val moves = HashMap<String, String>()

    if (from.isDirectory && from.canonicalPath != to.canonicalPath) {
      to.mkdirs()
      from.listFiles()?.forEach { src ->
        if (!src.isFile || src.name == ".nomedia") return@forEach
        val dest = uniqueFile(to, src.name)
        val was = src.absolutePath
        // Both folders live on the same volume, so a rename is an atomic
        // metadata move. Fall back to copy+delete only if that ever fails.
        if (src.renameTo(dest) || copyThenDelete(src, dest)) {
          moved++
          moves[was] = dest.absolutePath
        }
      }
      rewritePaths(ctx, moves)
      // Drop the old folder once emptied, so an unhidden Downloads listing does
      // not keep showing a stale, empty "Orca" entry.
      if (from.listFiles()?.none { it.name != ".nomedia" } == true) {
        File(from, ".nomedia").delete()
        from.delete()
      }
    }

    to.mkdirs()
    applyNomedia(to, hidden)
    rememberHidden(ctx, hidden)
    // Re-scan BOTH trees: the old paths must disappear from the gallery and the
    // new ones appear (or stay absent, for the hidden tree).
    rescan(ctx, from)
    rescan(ctx, to)
    return moved
  }

  /**
   * Stream `url` into the active folder. Returns the absolute path written.
   * Runs on a background thread (see DownloadService) — never the main looper.
   *
   * When [slug] is given the result is recorded in the local-file registry, and
   * any previous copy of that same item is deleted once the new one has landed.
   * That ordering matters: it is what makes "the user asked for a better
   * resolution" a replacement rather than two files, and deleting only after the
   * new file is safely renamed into place means a failed upgrade leaves the
   * existing copy intact instead of destroying it.
   */
  fun save(
    ctx: Context,
    url: String,
    fallbackName: String,
    slug: String = "",
    height: Int = 0,
    onProgress: (pct: Int) -> Unit,
  ): File {
    check(granted(ctx)) { "storage permission not granted" }
    val dir = dir(ctx)
    if (!dir.mkdirs() && !dir.isDirectory) error("can't create ${dir.absolutePath}")
    applyNomedia(dir, isHidden(ctx))

    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 15000
      readTimeout = 30000
      instanceFollowRedirects = true
    }
    try {
      val code = conn.responseCode
      if (code !in 200..299) error("server returned HTTP $code")

      val dest = uniqueFile(dir, filenameFrom(conn, fallbackName))
      val total = contentLength(conn)
      // Write to a temp sibling first: a save interrupted by a dead network or
      // the process being reclaimed must not leave a truncated file sitting in
      // Downloads looking like a complete video.
      val part = File(dest.parentFile, dest.name + ".part")
      var done = 0L
      var lastPct = -1
      conn.inputStream.use { input ->
        part.outputStream().use { output ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            output.write(buf, 0, n)
            done += n
            if (total > 0) {
              val pct = ((done * 100) / total).toInt().coerceIn(0, 100)
              if (pct != lastPct) { lastPct = pct; onProgress(pct) }
            }
          }
        }
      }
      if (!part.renameTo(dest)) {
        part.delete()
        error("can't finalise ${dest.name}")
      }
      // Supersede the previous copy of this item, now that the new one is safely
      // on disk. Skipped when it resolved to the same file (uniqueFile only
      // renames on collision, so this is belt-and-braces).
      val previous = if (slug.isEmpty()) null else localFile(ctx, slug)
      remember(ctx, slug, dest, height)
      if (previous != null && previous.path != dest.absolutePath) {
        val old = File(previous.path)
        if (old.delete()) rescan(ctx, old)
      }
      // Make it visible to Files/Gallery immediately. A hidden save is scanned
      // too: the scanner honours .nomedia and simply records nothing, while
      // skipping the call entirely would leave a stale entry after an unhide.
      rescan(ctx, dest)
      return dest
    } finally {
      conn.disconnect()
    }
  }

  private fun contentLength(conn: HttpURLConnection): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      conn.contentLengthLong
    } else {
      conn.contentLength.toLong()
    }

  /**
   * Prefer the server's own name. Orca sends RFC 5987
   * (`attachment; filename*=UTF-8''<percent-encoded>`, see media.rs); the plain
   * `filename=` form is handled for completeness.
   */
  private fun filenameFrom(conn: HttpURLConnection, fallback: String): String {
    val cd = conn.getHeaderField("Content-Disposition").orEmpty()
    val extended = Regex("filename\\*\\s*=\\s*UTF-8''([^;]+)", RegexOption.IGNORE_CASE)
      .find(cd)?.groupValues?.get(1)
      ?.let { try { URLDecoder.decode(it, "UTF-8") } catch (_: Exception) { null } }
    val plain = Regex("filename\\s*=\\s*\"?([^\";]+)\"?", RegexOption.IGNORE_CASE)
      .find(cd)?.groupValues?.get(1)
    return sanitize(extended ?: plain ?: fallback)
  }

  /**
   * The name is server-supplied, so it is untrusted: keep the last path segment
   * only (no traversal, no absolute path), drop separators and control
   * characters, and bound the length so the write can't fail on a long name.
   */
  private fun sanitize(raw: String): String {
    val base = raw.substringAfterLast('/').substringAfterLast('\\')
      .map { if (it.isISOControl() || it in "\\/:*?\"<>|") '_' else it }
      .joinToString("")
      .trim()
      .trim('.')
    if (base.isEmpty()) return "orca-download"
    if (base.length <= 120) return base
    // Trim the stem, never the extension.
    val ext = base.substringAfterLast('.', "")
    val stem = if (ext.isEmpty()) base else base.dropLast(ext.length + 1)
    return if (ext.isEmpty()) stem.take(120) else stem.take(119 - ext.length) + "." + ext
  }

  /** `name`, or `name (2)`, `name (3)`… — never silently overwrite a save. */
  private fun uniqueFile(dir: File, name: String): File {
    val target = File(dir, name)
    if (!target.exists()) return target
    val ext = name.substringAfterLast('.', "")
    val stem = if (ext.isEmpty()) name else name.dropLast(ext.length + 1)
    for (i in 2..9999) {
      val candidate = File(dir, if (ext.isEmpty()) "$stem ($i)" else "$stem ($i).$ext")
      if (!candidate.exists()) return candidate
    }
    return File(dir, "$stem-${System.currentTimeMillis()}${if (ext.isEmpty()) "" else ".$ext"}")
  }

  private fun copyThenDelete(src: File, dest: File): Boolean = try {
    src.inputStream().use { i -> dest.outputStream().use { o -> i.copyTo(o) } }
    src.delete()
    true
  } catch (_: Exception) {
    dest.delete()
    false
  }

  /** Tell the media scanner a path changed (best-effort, async by nature). */
  private fun rescan(ctx: Context, path: File) {
    try {
      MediaScannerConnection.scanFile(ctx, arrayOf(path.absolutePath), null, null)
    } catch (_: Exception) { /* best-effort */ }
  }
}
