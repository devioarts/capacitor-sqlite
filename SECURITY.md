# Security Policy

## Supported Versions

Security fixes are considered for the latest published version.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Report security concerns privately through GitHub's private vulnerability reporting if it is
enabled for this repository. If that is not available, contact the maintainer directly through the
repository owner profile.

Include:

- affected platform or platforms: iOS, Android, Web/OPFS, Electron
- plugin version and Capacitor version
- a minimal reproduction or clear steps to reproduce
- expected impact and whether untrusted input is involved

This plugin intentionally accepts raw SQL from trusted application code. Reports involving SQL
injection should explain how untrusted SQL text reaches the plugin API rather than parameterized
`values`.
