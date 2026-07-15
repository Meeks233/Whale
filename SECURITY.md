# Security Policy

## Supported Version

Security fixes target the current `main` branch and latest published image. Use an
immutable full-SHA image tag when you need to identify an exact deployment.

## Reporting

Do not open a public issue for a vulnerability involving authentication bypass,
cookie/token disclosure, SSRF, path escape, command execution, or public-share
capabilities. Use GitHub's private vulnerability reporting for this repository.
Include affected revision, deployment assumptions, reproduction steps, impact,
and any proposed mitigation. Do not access data or systems you do not own.

## Deployment Baseline

- generate a high-entropy owner token
- keep TOFU disabled unless registration occurs on a controlled private network
- use HTTPS outside a trusted LAN and bind the container to loopback behind a proxy
- protect `/data`, cookie files, backups, and logs
- deny container egress to private and cloud metadata networks for strong SSRF
  isolation
- update from CI-verified immutable image tags

Public share URLs are bearer capabilities. Revoke a link immediately if disclosed;
Whale destroys the capability and creates a different one on the next share.
