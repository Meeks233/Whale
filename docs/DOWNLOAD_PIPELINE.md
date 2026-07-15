# Download Pipeline

1. Normalize known shared/mobile URL forms and remove tracking parameters.
2. Require HTTP(S), reject forbidden literal hosts, resolve DNS, and reject any
   private/reserved answer unless the explicit fake-IP compatibility flag is set.
3. Match the website registry. Reject disabled sites and select its cookie jar.
4. Acquire one of two probe slots and run yt-dlp with ignored user config, no
   download, a 120-second timeout, and 500-entry playlist limit.
5. Parse required metadata and available real-video heights. Multi-video entries
   sharing one webpage URL retain their playlist index.
6. Deduplicate by archive key. A normal duplicate returns its existing row.
7. Insert a new item with a random private slug, or mark it completed without a
   file when global/per-site stream-only mode applies.
8. Send the job to the bounded queue. A semaphore and polite pacing control start
   rate; per-job options add output format, archive, cookies, subtitles, thumbnail,
   rate limit, fragments, and progress template.
9. Parse progress lines and broadcast SSE events. Delete/reselection can signal
   the matching child process through the cancellation map.
10. On success, record the confined output, size, height, variant, completion time,
    and archive key. On failure, store a user-facing explanation and bounded log.

Resolution variants use separate output/sidecar tags and are queued highest first.
Removing a variant cancels an active matching job, deletes its confined file, and
repoints the primary item fields. Empty selection clears all local variants while
retaining metadata for online playback.

Online playback separately validates the stored page URL, resolves a short-lived
upstream URL with yt-dlp, validates that URL, and proxies Range requests. Cookie
selection enforces domain, subdomain, path, Secure, and expiry semantics.
