package com.orca.app

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Shared Orca backend client for native code: credential lookup plus the E2EE
 * envelope the server speaks.
 *
 * Both the "Quick Download" share target (ShareActivity) and the download
 * notification service (DownloadService) talk to the same backend the WebView
 * does, so the request/response sealing lives here once instead of being copied
 * into each caller.
 */
object OrcaApi {
  data class Creds(val base: String, val token: String)
  data class Credential(val keyId: String, val key: SecretKeySpec)

  /**
   * Server base + token, mirrored out of the WebView's localStorage into
   * `<dataDir>/orca_share_creds.json` by the `save_share_creds` Tauri command.
   * Native code cannot read localStorage, so this file is the only channel.
   */
  fun readCreds(ctx: Context): Creds? = try {
    val f = File(ctx.dataDir, "orca_share_creds.json")
    if (!f.exists()) {
      null
    } else {
      val o = JSONObject(f.readText())
      val base = o.optString("base").trimEnd('/')
      val token = o.optString("token")
      if (base.isEmpty() || token.isEmpty()) null else Creds(base, token)
    }
  } catch (e: Exception) {
    null
  }

  private fun sha256(bytes: ByteArray): ByteArray =
    MessageDigest.getInstance("SHA-256").digest(bytes)

  /** Derive the key id + AES key from the bearer token (mirrors src/e2ee.rs). */
  fun credential(token: String): Credential {
    val authHash = sha256(token.toByteArray(Charsets.UTF_8))
    val keyId = sha256("orca-e2ee-kid-v1\u0000".toByteArray() + authHash)
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    val key = sha256("orca-e2ee-key-v1\u0000".toByteArray() + authHash)
    return Credential(keyId, SecretKeySpec(key, "AES"))
  }

  private fun seal(credential: Credential, plaintext: ByteArray, aad: String): String {
    val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, credential.key, GCMParameterSpec(128, nonce))
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    return JSONObject()
      .put("v", 1)
      .put("n", Base64.encodeToString(nonce, Base64.NO_WRAP))
      .put("c", Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP))
      .toString()
  }

  private fun open(credential: Credential, envelope: String, aad: String): String {
    val parsed = JSONObject(envelope)
    require(parsed.optInt("v") == 1) { "invalid encrypted response" }
    val nonce = Base64.decode(parsed.getString("n"), Base64.DEFAULT)
    val ciphertext = Base64.decode(parsed.getString("c"), Base64.DEFAULT)
    require(nonce.size == 12 && ciphertext.size >= 16) { "invalid encrypted response" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, credential.key, GCMParameterSpec(128, nonce))
    cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
    return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
  }

  private fun configureE2ee(conn: HttpURLConnection, credential: Credential, hasBody: Boolean) {
    conn.setRequestProperty("X-Orca-E2EE", "1")
    conn.setRequestProperty("X-Orca-Key-Id", credential.keyId)
    if (hasBody) {
      conn.setRequestProperty("X-Orca-Encrypted-Body", "1")
      conn.setRequestProperty("Content-Type", "text/plain")
    }
  }

  private fun readResponse(
    conn: HttpURLConnection,
    credential: Credential,
    path: String,
  ): Pair<Int, String> {
    val code = conn.responseCode
    val stream = if (code in 200..299) conn.inputStream else conn.errorStream
    val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
    val plaintext = if (conn.getHeaderField("X-Orca-E2EE") == "1") {
      open(credential, body, "$code\n$path")
    } else {
      body
    }
    return Pair(code, plaintext)
  }

  /** GET `<base><path>`, returning (HTTP status, decrypted body). */
  fun get(base: String, credential: Credential, path: String): Pair<Int, String> {
    val conn = (URL("$base$path").openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 15000
      readTimeout = 20000
      configureE2ee(this, credential, false)
    }
    return try {
      readResponse(conn, credential, path)
    } finally {
      conn.disconnect()
    }
  }

  /** POST `payload` (sealed) to `<base><path>`, returning (HTTP status, decrypted body). */
  fun post(
    base: String,
    credential: Credential,
    path: String,
    payload: String,
  ): Pair<Int, String> {
    val conn = (URL("$base$path").openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 15000
      readTimeout = 30000
      doOutput = true
      configureE2ee(this, credential, true)
    }
    return try {
      conn.outputStream.use {
        it.write(seal(credential, payload.toByteArray(), "POST\n$path").toByteArray())
      }
      readResponse(conn, credential, path)
    } finally {
      conn.disconnect()
    }
  }
}
