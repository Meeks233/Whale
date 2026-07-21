package com.meeks233.orca

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.OutputStream
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * A loopback HTTP server that **streams remote media through the Orca Secure
 * Channel** so the app's `<video>` can play a cloud item (or a server-side file)
 * with no service worker and no whole-file buffering.
 *
 * Why this exists: the Android WebView has no controlling service worker, so
 * `<img>`/`<video>` can't use the `/__m/` E2EE plane, and the server honours the
 * plaintext `?token=` fallback for loopback peers only — a real phone is refused.
 * The frontend can fetch+decrypt small media (thumbnails) itself, but a whole-file
 * blob makes `<video>` wait for the entire download before the first frame. This
 * proxy closes that gap the same way [LocalMediaServer] does for on-device files:
 * a real loopback HTTP origin the media stack will range-request, backed here by
 * the encrypted windowed media protocol (see src/api/emedia.rs + frontend/sw.ts).
 *
 * Security posture — the E2EE model is unchanged, not weakened:
 *  - It performs the same forward-secret P-256 handshake the browser does
 *    (`POST /api/session`), mixing SHA256(token) in as the PSK, and authenticates
 *    every window with a fresh sealed authenticator. The raw token never rides a
 *    request; a Cloudflare edge sees only ciphertext and an opaque session id.
 *  - The loopback socket is bound to 127.0.0.1 on an OS-chosen ephemeral port, and
 *    every URL carries a fresh 128-bit token, so nothing off-device can reach it
 *    and the decrypted bytes never leave this process except to its own WebView.
 */
object RemoteMediaProxy {
  private const val MEDIA_CHUNK = 65536
  private const val MEDIA_TAG = 16
  private val SESSION_INFO = "orca-osc-v2-session".toByteArray(Charsets.UTF_8) + byteArrayOf(0)
  private val MEDIA_INFO = "orca-osc-v2-media".toByteArray(Charsets.UTF_8) + byteArrayOf(0)

  private var server: ServerSocket? = null
  private var port: Int = 0
  private val urlToken: String by lazy {
    ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  // One forward-secret session, established lazily and reused across windows.
  // Rebuilt on a 401 (server-side expiry) or when the creds change.
  private class Session(val base: String, val token: String, val sid: String, val key: ByteArray)
  private var session: Session? = null
  private val handshakeLock = Any()

  /**
   * A loopback URL the WebView's `<video>` can play for a remote [kind] resource.
   * `kind` is `"stream"` (cloud proxy) or `"file"` (a file the server holds);
   * `null` when there are no synced creds to reach the server with.
   */
  fun urlFor(ctx: Context, kind: String, slug: String, height: Int = 0): String? {
    if (slug.isEmpty() || (kind != "stream" && kind != "file")) return null
    if (OrcaApi.readCreds(ctx) == null) return null
    val p = ensureStarted(ctx)
    // The resolution cap only applies to a cloud 'stream' resolve; it rides the
    // loopback URL query and is forwarded to the server's /api/stream request.
    val h = if (kind == "stream" && height > 0) "?h=$height" else ""
    return "http://127.0.0.1:$p/$urlToken/$kind/${enc(slug)}$h"
  }

  private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

  @Synchronized
  private fun ensureStarted(ctx: Context): Int {
    server?.let { if (!it.isClosed) return port }
    val s = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    server = s
    port = s.localPort
    val app = ctx.applicationContext
    Thread({ acceptLoop(app, s) }, "orca-remote-media").apply { isDaemon = true; start() }
    return port
  }

  private fun acceptLoop(ctx: Context, s: ServerSocket) {
    while (!s.isClosed) {
      val client = try { s.accept() } catch (_: Exception) { return }
      Thread { handle(ctx, client) }.apply { isDaemon = true }.start()
    }
  }

  // ---- Loopback HTTP (mirrors LocalMediaServer's framing) -------------------

  private fun handle(ctx: Context, client: Socket) {
    try {
      client.use { sock ->
        sock.soTimeout = 20000
        val input = sock.getInputStream().bufferedReader()
        val requestLine = input.readLine() ?: return
        var range: String? = null
        while (true) {
          val line = input.readLine() ?: break
          if (line.isEmpty()) break
          if (line.startsWith("Range:", ignoreCase = true)) range = line.substringAfter(':').trim()
        }
        val parts = requestLine.split(' ')
        if (parts.size < 2) return respondStatus(sock.getOutputStream(), 400, "Bad Request")
        val method = parts[0]
        val target = resolve(parts[1]) ?: return respondStatus(sock.getOutputStream(), 404, "Not Found")
        serve(ctx, sock.getOutputStream(), target, range, includeBody = method != "HEAD")
      }
    } catch (_: Exception) {
      // A media element abandons connections constantly while seeking; a broken
      // pipe is normal and must not take the server down.
    }
  }

  private class Target(val kind: String, val slug: String, val height: Int) {
    val apiPath: String = if (kind == "stream") "/api/stream/${enc(slug)}" else "/api/items/${enc(slug)}/file"
    val resource: String = "$kind:$slug"
    // Rides the server fetch URL only (never the authenticator, which the server
    // binds to the path). A cap applies to the online-stream resolve alone.
    val fetchSuffix: String = if (kind == "stream" && height > 0) "?h=$height" else ""
  }

  /** `/<token>/<kind>/<slug>[?h=N]` → the resource, or null on a bad token/shape. */
  private fun resolve(rawPath: String): Target? {
    val pathOnly = rawPath.trimStart('/').substringBefore('?')
    val segs = pathOnly.split('/')
    if (segs.size < 3 || segs[0] != urlToken) return null
    val kind = segs[1]
    if (kind != "stream" && kind != "file") return null
    val slug = try { URLDecoder.decode(segs[2], "UTF-8") } catch (_: Exception) { return null }
    if (slug.isEmpty()) return null
    val query = rawPath.substringAfter('?', "")
    val height = query.split('&').firstOrNull { it.startsWith("h=") }
      ?.removePrefix("h=")?.toIntOrNull() ?: 0
    return Target(kind, slug, height)
  }

  /**
   * Serve an HTTP range by streaming decrypted E2EE windows from `start` onward,
   * flushing each as it arrives — so playback starts on the first window instead
   * of waiting for the whole file. A seek closes this and issues a new range.
   */
  private fun serve(ctx: Context, out: OutputStream, t: Target, range: String?, includeBody: Boolean) {
    // Learn the total plaintext length (and the first window) up front.
    val start = parseRangeStart(range)
    val first = try {
      window(ctx, t, start)
    } catch (e: Exception) {
      return respondStatus(out, if (e is SessionExpired) 502 else 502, "Bad Gateway")
    }
    val total = first.plainLen
    if (total == 0L) {
      out.write("HTTP/1.1 200 OK\r\nContent-Type: ${contentType(t)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
      out.flush(); return
    }
    if (start >= total) {
      out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$total\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").toByteArray())
      out.flush(); return
    }
    val partial = range != null
    val last = total - 1
    val length = last - start + 1
    val sb = StringBuilder()
    sb.append(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
    sb.append("Content-Type: ${contentType(t)}\r\n")
    sb.append("Content-Length: $length\r\n")
    sb.append("Accept-Ranges: bytes\r\n")
    if (partial) sb.append("Content-Range: bytes $start-$last/$total\r\n")
    sb.append("Access-Control-Allow-Origin: *\r\n")
    sb.append("Cache-Control: no-store\r\n")
    sb.append("Connection: close\r\n\r\n")
    out.write(sb.toString().toByteArray())
    if (!includeBody) { out.flush(); return }

    // First window: drop the bytes before `start` (the window is chunk-aligned).
    var win = first
    var pos = win.windowStart
    while (true) {
      val from = if (start > pos) (start - pos).toInt() else 0
      if (from < win.plaintext.size) out.write(win.plaintext, from, win.plaintext.size - from)
      out.flush()
      pos += win.plaintext.size
      if (pos >= total) break
      win = try { window(ctx, t, pos) } catch (_: Exception) { break }
      if (win.plaintext.isEmpty()) break
    }
    out.flush()
  }

  private fun contentType(t: Target): String = "video/mp4" // the media stack sniffs; a sane default is enough

  private fun parseRangeStart(range: String?): Long {
    if (range == null || !range.startsWith("bytes=")) return 0
    val spec = range.removePrefix("bytes=").trim()
    return spec.substringBefore('-').toLongOrNull() ?: 0
  }

  private fun respondStatus(out: OutputStream, code: Int, text: String) {
    out.write("HTTP/1.1 $code $text\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
    out.flush()
  }

  // ---- Orca Secure Channel client ------------------------------------------

  private class SessionExpired : Exception()
  private class Window(val plainLen: Long, val windowStart: Long, val plaintext: ByteArray)

  /** Fetch + decrypt one encrypted window starting at plaintext byte [start]. */
  private fun window(ctx: Context, t: Target, start: Long): Window {
    return try {
      fetchWindow(ensureSession(ctx), t, start)
    } catch (_: SessionExpired) {
      // Server-side expiry: drop the cached session and re-handshake once.
      synchronized(handshakeLock) { session = null }
      fetchWindow(ensureSession(ctx), t, start)
    }
  }

  private fun fetchWindow(s: Session, t: Target, start: Long): Window {
    val conn = (URL("${s.base}${t.apiPath}${t.fetchSuffix}").openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 15000
      readTimeout = 30000
      setRequestProperty("X-Orca-Sid", s.sid)
      setRequestProperty("X-Orca-Auth", authenticator(s.key, "GET", t.apiPath))
      setRequestProperty("X-Orca-Range", "$start-")
    }
    try {
      val code = conn.responseCode
      if (code == 401) throw SessionExpired()
      if (code !in 200..299 || conn.getHeaderField("X-Orca-E2EE") != "1") {
        throw Exception("media fetch $code")
      }
      val plainLen = conn.getHeaderField("X-Orca-Plain-Len")?.toLongOrNull() ?: 0L
      val i0 = conn.getHeaderField("X-Orca-Chunk-Index")?.toLongOrNull() ?: 0L
      val body = conn.inputStream.use { it.readBytes() }
      val streamKey = hkdf(s.key, ByteArray(0), MEDIA_INFO + t.resource.toByteArray(Charsets.UTF_8), 32)
      val out = java.io.ByteArrayOutputStream(body.size)
      var off = 0
      var idx = i0
      while (off < body.size) {
        val ptLen = minOf(MEDIA_CHUNK.toLong(), plainLen - idx * MEDIA_CHUNK).toInt()
        val ctLen = ptLen + MEDIA_TAG
        out.write(openChunk(streamKey, idx, body, off, ctLen))
        off += ctLen
        idx += 1
      }
      return Window(plainLen, i0 * MEDIA_CHUNK, out.toByteArray())
    } finally {
      conn.disconnect()
    }
  }

  private fun ensureSession(ctx: Context): Session {
    session?.let { return it }
    synchronized(handshakeLock) {
      session?.let { return it }
      val creds = OrcaApi.readCreds(ctx) ?: throw Exception("no creds")
      val s = handshake(creds.base, creds.token)
      session = s
      return s
    }
  }

  /** The forward-secret P-256 handshake — mirrors frontend/src/e2ee.ts `handshake`. */
  private fun handshake(base: String, token: String): Session {
    val ap = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
    val ecSpec = ap.getParameterSpec(ECParameterSpec::class.java)
    val kpg = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
    val kp = kpg.generateKeyPair()
    val pub = kp.public as ECPublicKey
    val epkC = byteArrayOf(0x04) + fixed(pub.w.affineX, 32) + fixed(pub.w.affineY, 32)
    val nC = ByteArray(16).also { SecureRandom().nextBytes(it) }

    val body = JSONObject()
      .put("epk", Base64.encodeToString(epkC, Base64.NO_WRAP))
      .put("n", Base64.encodeToString(nC, Base64.NO_WRAP))
      .toString()
    val conn = (URL("$base/api/session").openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 15000
      readTimeout = 20000
      doOutput = true
      setRequestProperty("Content-Type", "application/json")
    }
    val resp = try {
      conn.outputStream.use { it.write(body.toByteArray()) }
      if (conn.responseCode !in 200..299) throw Exception("handshake ${conn.responseCode}")
      conn.inputStream.use { it.bufferedReader().readText() }
    } finally {
      conn.disconnect()
    }
    val j = JSONObject(resp)
    val epkS = Base64.decode(j.getString("epk"), Base64.DEFAULT) // 0x04||X||Y
    val nS = Base64.decode(j.getString("n"), Base64.DEFAULT)
    val sid = j.getString("sid")

    val sx = epkS.copyOfRange(1, 33)
    val sy = epkS.copyOfRange(33, 65)
    val serverPub = KeyFactory.getInstance("EC").generatePublic(
      ECPublicKeySpec(ECPoint(BigInteger(1, sx), BigInteger(1, sy)), ecSpec)
    )
    val ka = KeyAgreement.getInstance("ECDH").apply { init(kp.private); doPhase(serverPub, true) }
    val sharedX = ka.generateSecret() // P-256 shared secret = 32-byte X coordinate

    val psk = sha256(token.toByteArray(Charsets.UTF_8))
    val key = hkdf(sharedX, nC + nS, SESSION_INFO + psk, 32)
    return Session(base, token, sid, key)
  }

  // ---- Crypto primitives (mirror src/e2ee.rs / frontend e2ee.ts) -----------

  private fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(32) else key, "HmacSHA256"))
    return mac.doFinal(data)
  }

  /** HKDF-SHA256. An empty salt means HashLen zero bytes (RFC 5869). */
  private fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, len: Int): ByteArray {
    val prk = hmac(salt, ikm)
    val out = java.io.ByteArrayOutputStream()
    var t = ByteArray(0)
    var i = 1
    while (out.size() < len) {
      t = hmac(prk, t + info + byteArrayOf(i.toByte()))
      out.write(t)
      i += 1
    }
    return out.toByteArray().copyOf(len)
  }

  /** AES-256-GCM seal into the JSON envelope the server opens; token stays off-wire. */
  private fun seal(key: ByteArray, plaintext: ByteArray, aad: String): String {
    val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    return JSONObject()
      .put("v", 1)
      .put("n", Base64.encodeToString(nonce, Base64.NO_WRAP))
      .put("c", Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP))
      .toString()
  }

  private fun authenticator(key: ByteArray, method: String, path: String): String {
    val nonce = ByteArray(16).also { SecureRandom().nextBytes(it) }
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    val payload = JSONObject().put("t", System.currentTimeMillis() / 1000).put("n", nonce).toString()
    val envelope = seal(key, payload.toByteArray(Charsets.UTF_8), "orca-auth-v1\n$method\n$path")
    return Base64.encodeToString(envelope.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
  }

  /** Decrypt one sealed media chunk: nonce = 4 zero bytes ‖ big-endian u64 index. */
  private fun openChunk(streamKey: ByteArray, index: Long, body: ByteArray, off: Int, len: Int): ByteArray {
    val nonce = ByteArray(12)
    var v = index
    for (b in 11 downTo 4) { nonce[b] = (v and 0xff).toByte(); v = v ushr 8 }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(streamKey, "AES"), GCMParameterSpec(128, nonce))
    return cipher.doFinal(body, off, len)
  }

  /** Left-pad an EC affine coordinate to exactly [size] bytes. */
  private fun fixed(v: BigInteger, size: Int): ByteArray {
    var b = v.toByteArray()
    if (b.size == size) return b
    if (b.size == size + 1 && b[0].toInt() == 0) return b.copyOfRange(1, b.size) // strip sign byte
    val out = ByteArray(size)
    if (b.size < size) System.arraycopy(b, 0, out, size - b.size, b.size)
    else System.arraycopy(b, b.size - size, out, 0, size)
    return out
  }
}
