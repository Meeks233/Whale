# Privacy Policy

Effective date: 2026-07-16

Orca is a self-hosted application. The project maintainers do not operate an
Orca account service, analytics service, advertising network, telemetry
collector, or media download service.

## Data handled by the app

The Android app stores the server address, access token, language, theme, and
permission choices in the app's private local storage. It sends URLs you submit,
authentication material, and related requests only to the Orca server you
configure. Authenticated JSON requests are encrypted between the app and that
server. A user may explicitly configure plain HTTP for a private LAN; HTTPS is
required for public network addresses.

The server operator controls downloaded media, metadata, history, cookies,
error logs, and access records. Source websites and network providers may
receive the requests needed to resolve or download a user-submitted URL under
their own terms and privacy policies.

## Sharing, retention, and deletion

The Orca project maintainers do not receive or sell app data. Data is retained
on the configured server until its operator or an authorized user deletes it.
Users can delete individual records and downloaded files in the app. Server
operators can remove all data by deleting the server's data and download
directories.

Public media links are created only by an authorized user. They use random,
revocable capabilities and may have an expiry time. Anyone who receives a live
public link can access that shared media until it expires or is revoked.

## Android permissions

Orca uses internet access to contact the configured server, notification
permission to report download status, wake lock and optional battery-optimization
exemption to keep user-requested progress reporting active. It does not request
location, contacts, camera, microphone, advertising ID, or broad file access.

## Contact

Privacy and security reports can be filed at
https://github.com/Meeks233/Orca/issues or through the private process described
in https://github.com/Meeks233/Orca/blob/main/SECURITY.md.
