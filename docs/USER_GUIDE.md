# User Guide

## History and Search

History is newest-first and keyset paginated. Search accepts words and quoted
phrases plus `title:`, `user:`, `platform:`, `status:`, and `id:` filters. Prefix
a term with `-` to exclude it. The numeric `id:` filter is an owner-only database
search convenience; item URLs never accept numeric IDs.

Cards show status, progress, platform, uploader, duration, total local size, and
available actions. Playlist and multi-video entries are folded into groups.

## Playback and Files

Completed local items play through a range-capable authenticated file endpoint.
Stream-only or missing-local-file items use Orca's online proxy, which resolves
the upstream URL with the applicable cookie jar and proxies bytes from the server.
The save action forces a browser download.

## Resolutions

Open the layers control to keep one or more source resolutions. Adding a height
queues a variant; removing one deletes its confined local file. Selecting no
height converts the record to stream-only mode. A request is limited to 16
heights.

## Sharing

Only completed items with local files can be shared. Choose 7 days, 30 days, or
permanent. Public links require no owner token and count fresh accesses. Stopping
or expiring a share destroys its capability; creating another share produces a
new URL, so old links never reactivate.

## Website and Cookie Management

Each website entry controls aliases, login URL, enabled state, resolution cap,
stream-only mode, privacy blur, and cookie state. Disabled sites are rejected
before probing. Merge consolidates aliases and cookie/file ownership. Cookie
switching preserves the jar by renaming it; deletion removes enabled and disabled
copies.

## Batch Operations

Selection mode supports select all, invert, download, share, stop sharing, copy
links, clean local files, and delete. Website selection supports select all,
invert, enable, disable, merge, and delete.
