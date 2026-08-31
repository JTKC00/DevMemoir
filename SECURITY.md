# Security Policy

DevMemoir is in active development and is not represented as production-ready. Security reports are welcome when they include enough detail to reproduce and assess the issue, but no bug bounty or response-time commitment is implied unless separately announced.

## Reporting

Please do not open a public issue or pull request for a suspected vulnerability. Use GitHub's private vulnerability reporting feature for this repository when enabled. If that route is unavailable, contact the maintainers through a private GitHub channel before disclosure.

Do not include real secrets, private repository content, raw webhook payloads, personal access tokens, private keys, or production credentials in a report. Use a synthetic fixture and redact sensitive values while preserving the relevant shape.

Useful reports include:

- a concise description of the security impact and affected boundary;
- the affected revision, file, route, or workflow;
- minimal reproduction steps using synthetic data;
- prerequisites, configuration assumptions, and observed results;
- a suggested mitigation, if known.

The project is owner-led. The maintainer will acknowledge and assess reports as capacity allows, may request additional sanitized evidence, and will decide on disclosure and remediation timing.
