---
name: security-review
description: Security-focused review of a diff or commit range — injection, secrets, trust boundaries, authz, unsafe deserialization, supply chain, and path/command safety, ranked by exploitability. Use when asked to security-review changes or as the second pass of a full review.
---

# Security review

Review the change as an attacker would read it: every new input is hostile,
every boundary crossing is an opportunity. Grounded in the OWASP code-review
model — findings ranked by exploitability, not by pattern-match count.

## Checklist by trust boundary

**Inputs (anything the process didn't create itself)**
- Command injection: user/config/network data reaching `exec`/`spawn`/shell
  strings. Quoting is not escaping; prefer argv arrays. Flag every
  interpolated shell string that carries external data.
- Path traversal: joins with external segments (`../`), symlink following,
  zip-slip in extraction. Require canonicalize-then-prefix-check.
- Injection into interpreters: SQL/NoSQL/LDAP/regex/eval/Function/template
  engines fed external strings.
- Deserialization: YAML/JSON/pickle-style loads of untrusted bytes with
  type resolution or object construction.
- SSRF: URLs from outside fetched by the server; check scheme/host pinning.

**Secrets & data**
- Hardcoded credentials, tokens, private keys — including in tests, fixtures,
  and example configs. Entropy-looking strings deserve a question.
- Secrets in logs, error messages, process args (visible in `ps`), URLs.
- New persistence of sensitive data: is it needed, is it protected, is it
  cleaned up on retire/delete paths?

**AuthN/AuthZ**
- New endpoints/commands/IPC surfaces: who can reach them, and what do they
  authorize against? "Bound to localhost" is a real but WEAK boundary — note
  what a local malicious process could do.
- Privilege boundaries: does the change let low-trust config/data cause
  high-trust execution (hooks, plugins, migrations, CI)?
- TOCTOU: check-then-use on files/permissions/state.

**Supply chain & execution**
- New dependencies: are they necessary, pinned, and from expected owners?
- Downloaded/cloned artifacts: integrity-checked before execution?
- Anything that writes then executes (temp scripts, curl|sh patterns).

**Web-facing (when applicable)**
- XSS: external strings reaching innerHTML/attributes without escaping.
- CSRF on state-changing endpoints; CORS wildcards; missing content-type
  discipline on APIs.

## Reporting

- Verdict shares the scale: `APPROVE` / `APPROVE WITH NITS` / `NEEDS CHANGES`
  — any credible injection/secret/authz finding is a **blocker**.
- Each finding: `severity — file:line — attack scenario in one sentence +
  concrete fix`. If you cannot articulate the attack, downgrade to a
  question rather than inventing a threat.
- Distinguish "exploitable now" from "hardening" — both are reportable,
  only the first blocks.
