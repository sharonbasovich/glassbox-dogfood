# Threat model

**Assets:** unpublished scores, the integrity of the ranking, project drafts, accounts, and the audit trail.
**Actors:** visitor, participant, judge, organizer (per event), admin (per instance).

| Threat | Mitigation | Test |
| --- | --- | --- |
| A judge reads another judge's scores (to anchor, or to leak them) | `readJudgeScores` allows only self, or an organizer of that judge's event. Enforced in the service layer; the checker covers it. | `authz.test.ts` matrix |
| A participant or visitor reads scores before publication | Scores are served only from organizer-scoped endpoints; public results come from a frozen aggregate snapshot with no judge IDs | `authz`, `lifecycle` |
| A late submission via the API or a replayed form | One server-clock check, `assertSubmissionWindow`, on every project write; the UI's disabled state is cosmetic | `lifecycle` deadline test |
| One team edits another team's project | `updateProject` requires membership of the owning team | `authz` team isolation |
| A judge scores an unassigned project, or their own team's | A score needs an assignment (DB foreign key); the judge and participant roles are mutually exclusive per event; recusal deletes the assignment | `authz` |
| An organizer of event A touches event B | Every organizer check is scoped per event (`event_roles`) | `authz` cross-event |
| Silent score or ranking changes after the fact | Scoring locks on publish; the published snapshot is hashed; the audit log is append-only (DB triggers) and hash-chained, with a verifier in the UI and CLI | `lifecycle` audit test |
| CSRF | Cookie sessions need a per-session token on every non-GET; `SameSite=Lax` cookies | `authz` CSRF test |
| XSS through project text | All HTML goes through the `h` tagged template, which escapes by default; strict CSP (`default-src 'self'`, no third-party origins); external links use `rel=noopener nofollow` | — |
| CSV/formula injection in exports | Cells starting with `= + - @` (unless numeric) get a `'` prefix | — |
| Password theft from a DB dump | scrypt (N=2¹⁴) with a per-user salt; session and API tokens are stored only as SHA-256 | — |
| Session fixation or leaks | Random 24-byte tokens, HttpOnly cookies, `Secure` when `GLASSBOX_SECURE_COOKIES=1`, 14-day expiry, logout deletes the session | — |
| Clickjacking | `X-Frame-Options: DENY` and `frame-ancestors 'none'` | — |
| Oversized requests | Body size cap in the router | — |

## Out of scope / operator responsibilities

- **TLS:** run behind a reverse proxy (Caddy or nginx) and set `GLASSBOX_SECURE_COOKIES=1`.
- **Demo credentials:** the seeded API tokens and `glassbox-demo` passwords are public. Set `GLASSBOX_DEMO_TOKENS=off` and `GLASSBOX_SEED=off` for real events, or rotate them.
- **Email:** invitations produce a one-time link that the organizer delivers; Glassbox never sends mail.
- **Admin trust:** admins and organizers can see all scores for their events. That's by design.
- **Login rate limiting:** there's no brute-force protection beyond scrypt cost. Put a proxy rate limit on `/login` for internet-facing deployments.
