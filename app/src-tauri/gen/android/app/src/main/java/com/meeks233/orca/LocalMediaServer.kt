package com.meeks233.orca

import android.content.Context
import java.io.File
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.security.SecureRandom

/**
 * A tiny loopback HTTP server that streams a saved file back to the app's own
 * WebView, so tapping Play on an item you've already saved plays the copy on this
 * device instead of re-downloading it from the server.
 *
 * Why this exists rather than `convertFileSrc()`: Tauri's asset protocol is
 * served through the WebView's request interceptor, and Android's WebView routes
 * `<video>` loads through a *separate* media stack that never consults that
 * interceptor. The symptom is precise and misleading — `fetch()` on an
 * `asset.localhost` URL returns the bytes perfectly, while a `<video>` pointed at
 * the identical URL sits at readyState 0 forever with no error. A real HTTP
 * origin is the only thing the media stack will talk to. (A blob: URL also plays,
 * but only by loading the entire file into memory first, which a multi-GB video
 * would not survive.)
 *
 * Security posture — this opens a socket, so it is deliberately narrow:
 *  - Bound to the loopback address only, so nothing off-device can reach it.
 *  - An ephemeral port, chosen by the OS, different every launch.
 *  - Every URL carries a 128-bit token generated fresh per process; a request
 *    without it is refused before any path is examined.
 *  - It serves ONLY files the local-file registry already knows about, looked up
 *    by item slug. There is no path in the request to traverse with: the client
 *    names a slug, and [MediaSaver] names the file. A guessed or stale slug is a
 *    404, not a read.
 */
object LocalMediaServer {
  private var server: ServerSocket? = null
  private var port: Int = 0
  private val token: String by lazy {
    val bytes = ByteArray(16)
    SecureRandom().nextBytes(bytes)
    bytes.joinToString("") { "%02x".format(it) }
  }

  /** Start on first use; subsequent calls are no-ops. Returns the live port. */
  @Synchronized
  private fun ensureStarted(ctx: Context): Int {
    server?.let { if (!it.isClosed) return port }
    // Port 0 = let the OS pick a free one. Loopback-only bind.
    val s = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    server = s
    port = s.localPort
    Thread({ acceptLoop(ctx.applicationContext, s) }, "orca-media-server").apply {
      isDaemon = true
      start()
    }
    return port
  }

  /**
   * A URL the WebView can play for [slug], or null when nothing is saved for it.
   * Checked up front so the caller never hands the player a URL that 404s.
   */
  fun urlFor(ctx: Context, slug: String): String? {
    if (slug.isEmpty() || MediaSaver.localFile(ctx, slug) == null) return null
    val p = ensureStarted(ctx)
    return "http://127.0.0.1:$p/$token/$slug"
  }

  private fun acceptLoop(ctx: Context, s: ServerSocket) {
    while (!s.isClosed) {
      val client = try {
        s.accept()
      } catch (_: Exception) {
        return // socket closed; nothing left to serve
      }
      // One thread per connection: a media element opens several in parallel for
      // seeking, and they must not queue behind each other.
      Thread { handle(ctx, client) }.apply { isDaemon = true }.start()
    }
  }

  private fun handle(ctx: Context, client: Socket) {
    try {
      client.use { sock ->
        sock.soTimeout = 15000
        val input = sock.getInputStream().bufferedReader()
        val requestLine = input.readLine() ?: return
        var range: String? = null
        while (true) {
          val line = input.readLine() ?: break
          if (line.isEmpty()) break
          if (line.startsWith("Range:", ignoreCase = true)) range = line.substringAfter(':').trim()
        }

        val parts = requestLine.split(' ')
        if (parts.size < 2) return respond(sock.getOutputStream(), 400, "Bad Request")
        val method = parts[0]
        val path = parts[1]
        val file = resolve(ctx, path) ?: return respond(sock.getOutputStream(), 404, "Not Found")
        // HEAD is answered like GET minus the body; the media stack probes with it.
        serve(sock.getOutputStream(), file, range, includeBody = method != "HEAD")
      }
    } catch (_: Exception) {
      // A media element abandons connections constantly while seeking; a broken
      // pipe here is normal and must not take the server down.
    }
  }

  /** `/<token>/<slug>` → the registered file, or null. */
  private fun resolve(ctx: Context, rawPath: String): File? {
    val segments = rawPath.trimStart('/').substringBefore('?').split('/')
    if (segments.size != 2) return null
    // Constant-time-ish compare is overkill for a loopback token, but bail before
    // touching the registry if it's wrong.
    if (segments[0] != token) return null
    val slug = try {
      URLDecoder.decode(segments[1], "UTF-8")
    } catch (_: Exception) {
      return null
    }
    val local = MediaSaver.localFile(ctx, slug) ?: return null
    val f = File(local.path)
    return if (f.isFile) f else null
  }

  private fun serve(out: OutputStream, file: File, range: String?, includeBody: Boolean) {
    val total = file.length()
    val ctype = contentType(file.name)

    // "bytes=START-[END]" — the only form a media element sends.
    var start = 0L
    var end = total - 1
    var partial = false
    if (range != null && range.startsWith("bytes=")) {
      val spec = range.removePrefix("bytes=").trim()
      val s = spec.substringBefore('-')
      val e = spec.substringAfter('-', "")
      if (s.isNotEmpty()) {
        start = s.toLongOrNull() ?: 0L
        if (e.isNotEmpty()) end = e.toLongOrNull() ?: end
        partial = true
      }
    }
    if (start >= total || start < 0) {
      val head = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$total\r\n" +
        "Accept-Ranges: bytes\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      out.write(head.toByteArray()); out.flush(); return
    }
    if (end >= total) end = total - 1
    val length = end - start + 1

    val sb = StringBuilder()
    sb.append(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
    sb.append("Content-Type: $ctype\r\n")
    sb.append("Content-Length: $length\r\n")
    // Without Accept-Ranges the media stack refuses to seek and some builds
    // refuse to start at all.
    sb.append("Accept-Ranges: bytes\r\n")
    if (partial) sb.append("Content-Range: bytes $start-$end/$total\r\n")
    // The WebView origin (http://tauri.localhost) differs from this one.
    sb.append("Access-Control-Allow-Origin: *\r\n")
    sb.append("Cache-Control: no-store\r\n")
    sb.append("Connection: close\r\n\r\n")
    out.write(sb.toString().toByteArray())

    if (!includeBody) { out.flush(); return }
    file.inputStream().use { input ->
      input.skip(start)
      val buf = ByteArray(64 * 1024)
      var remaining = length
      while (remaining > 0) {
        val n = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
        if (n < 0) break
        out.write(buf, 0, n)
        remaining -= n
      }
    }
    out.flush()
  }

  private fun respond(out: OutputStream, code: Int, text: String) {
    out.write(
      ("HTTP/1.1 $code $text\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").toByteArray()
    )
    out.flush()
  }

  private fun contentType(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
    "mp4", "m4v" -> "video/mp4"
    "mkv" -> "video/x-matroska"
    "webm" -> "video/webm"
    "mov" -> "video/quicktime"
    "avi" -> "video/x-msvideo"
    "flv" -> "video/x-flv"
    "mp3" -> "audio/mpeg"
    "m4a" -> "audio/mp4"
    "opus", "ogg" -> "audio/ogg"
    else -> "application/octet-stream"
  }
}
