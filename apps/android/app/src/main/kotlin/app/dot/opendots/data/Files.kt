package app.dot.opendots.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import java.io.File

/** A document the user picked, described by its provider: real name, type and size. */
class PickedFile(val uri: Uri, val name: String, val mediaType: String, val size: Long) {
    val isImage: Boolean get() = mediaType in setOf("image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif")
}

fun describeFile(context: Context, uri: Uri): PickedFile {
    var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
    var size = -1L
    runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { cursor.getString(it) }?.takeIf { it.isNotBlank() }?.let { name = it }
                cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !cursor.isNull(it) }?.let { size = cursor.getLong(it) }
            }
        }
    }
    return PickedFile(uri, name, context.contentResolver.getType(uri) ?: "application/octet-stream", size)
}

/** Streams the picked document to the server unchanged: never loaded whole in memory. */
fun fileBody(context: Context, file: PickedFile): RequestBody = object : RequestBody() {
    override fun contentType() = file.mediaType.toMediaTypeOrNull()
    override fun contentLength() = file.size
    override fun writeTo(sink: BufferedSink) {
        (context.contentResolver.openInputStream(file.uri) ?: error("unreadable")).use { input -> sink.writeAll(input.source()) }
    }
}

private fun safeName(name: String?): String = (name ?: "file").replace(Regex("[/\\\\:*?\"<>|\\u0000-\\u001f]"), "_").trim().ifBlank { "file" }.takeLast(120)

/** Downloads a file of the thread into the app's cache (session required) and returns the local copy. */
suspend fun fetchToCache(context: Context, client: OpenDotsClient, file: Part.File): File = withContext(Dispatchers.IO) {
    val dir = File(context.cacheDir, "files/" + Integer.toHexString(file.url.hashCode())).apply { mkdirs() }
    val target = File(dir, safeName(file.filename))
    if (!target.exists() || target.length() == 0L) {
        val partial = File(dir, target.name + ".part")
        client.download(file.url, partial)
        if (!partial.renameTo(target)) { partial.copyTo(target, overwrite = true); partial.delete() }
    }
    target
}

/** Hands a downloaded file to whichever app can show it, through a read-only grant on that one file. */
fun viewIntent(context: Context, local: File, mediaType: String): Intent {
    val uri = FileProvider.getUriForFile(context, context.packageName + ".files", local)
    return Intent.createChooser(
        Intent(Intent.ACTION_VIEW).setDataAndType(uri, mediaType.ifBlank { "*/*" }).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
        local.name,
    ).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
}

/** Shares a downloaded file with a read-only grant on that one copy: the server address and session never leave. */
fun shareIntent(context: Context, local: File, mediaType: String): Intent {
    val uri = FileProvider.getUriForFile(context, context.packageName + ".files", local)
    return Intent.createChooser(
        Intent(Intent.ACTION_SEND).setType(mediaType.ifBlank { "*/*" }).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
        local.name,
    ).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
}

/** Copies a file of the thread, unchanged, to the place the user chose. */
suspend fun saveTo(context: Context, client: OpenDotsClient, file: Part.File, destination: Uri) = withContext(Dispatchers.IO) {
    val local = fetchToCache(context, client, file)
    (context.contentResolver.openOutputStream(destination) ?: error("unwritable")).use { out -> local.inputStream().use { it.copyTo(out) } }
}

fun formatBytes(size: Long): String = when {
    size < 0 -> ""
    size < 1024 -> "$size B"
    size < 1024 * 1024 -> "${(size + 512) / 1024} KB"
    else -> String.format(java.util.Locale.getDefault(), "%.1f MB", size / 1024.0 / 1024.0)
}

/** A short, human word for a file's type: its extension when it has one. */
fun fileKind(file: Part.File): String =
    file.filename?.substringAfterLast('.', "")?.takeIf { it.length in 1..8 && it.all(Char::isLetterOrDigit) }?.uppercase()
        ?: file.mediaType.substringAfter('/').substringBefore(';').substringAfterLast('.').substringAfterLast('-').uppercase().take(12)
