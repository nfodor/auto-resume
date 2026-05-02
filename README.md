# auto-resume

AI-customized resume engine — generates unique, role-tailored resumes per recruiter with visit tracking.

## Architecture

Three services work together:

| Service | Role |
|---------|------|
| **auto-resume** (this repo) | Core engine — ingests emails, matches profiles, serves resumes |
| **[email-mcp](https://github.com/nfodor/email-mcp)** | SMTP/IMAP — sends replies, imports inbox via IMAP |
| **[chromium-arm64](https://github.com/anthropics/chrome-devtools-mcp)** | Deep LinkedIn verification — scrapes recruiter profiles |
| **[urlyup.com](https://urlyup.com)** | Public URL tunneling — exposes local server to the internet |

```
Recruiter email → email-mcp (IMAP) → /api/incoming → verify + match profile → admin queue → approve → email-mcp sends reply with resume link
                                                                                              ↓
                                                                                  chromium-arm64 deep verifies
                                                                                  LinkedIn profiles for trust score
```

## How it works

1. **Sessions** — each pipeline run is a session. Create new sessions to test verification changes without losing old data. Switch between them in the admin.
2. **Import** — emails come in via IMAP (auto, set days) or via `.md` files dropped in `inbox/`
3. **Verification** — each email is scored on trust signals (DKIM/SPF/DMARC, reply-to consistency, LinkedIn profile presence + completeness, spammy language patterns)
4. **Profile matching** — subject/body keywords match to a profile variant (CTO, Architect, Full Stack, etc.)
5. **Admin queue** — everything lands as `pending`. You review, approve, skip, or delete.
6. **Approved emails** get a reply with a link to a role-specific resume page
7. **Visit tracking** logs each resume view (IP, UA, timestamp)
8. **Deep verify** — borderline entries can be verified via chromium-arm64 scraping the recruiter's LinkedIn profile for completeness signals (photo, headline, about, positions, education, followers)

## Setup

```bash
cp profiles.example.json profiles.json
# edit profiles.json with your contact info, skills, and experience

npm install
npm run dev
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3457` | Server port |
| `HOST` | `localhost` | Bind address |
| `PUBLIC_URL` | `http://localhost:3457` | Public-facing URL for resume links |
| `RESUME_NAME` | `Your Name` | Name in email replies |
| `RESUME_EMAIL` | `you@example.com` | Email in replies |
| `RESUME_PHONE` | `+1 (555) 000-0000` | Phone in replies |
| `MCP_API` | `http://localhost:3456/call` | Email MCP endpoint (IMAP + SMTP) |
| `MCP_TOKEN` | — | Auth token for email MCP |

## Integrations

### email-mcp
Provides IMAP inbox reading and SMTP email sending. The admin UI shows MCP + IMAP connection status. Configure `MCP_API` and `MCP_TOKEN` to enable:
- **IMAP import** — pull last N days of emails into a session
- **Auto-reply** — send custom replies when you approve entries

### chromium-arm64
Provides deep LinkedIn verification for borderline recruiters. Click "verify" on any entry with a LinkedIn URL, then run:
```
/Users/zebulon/.claude/skills/chromium-arm64/verify.sh <linkedin-url>
```
Results post back to `/api/verify-result` updating the trust score.

### urlyup.com
Exposes your local server with a public HTTPS URL. Set `PUBLIC_URL` to your urlyup tunnel URL so resume links in emails point to the public endpoint.

## Admin panel

`/admin` provides:
- **Session switcher** — create/switch between pipeline sessions
- **IMAP import** — set days and create a new session to pull inbox
- **Batch actions** — approve & send, skip, delete
- **Trust filters** — filter by verified/unverified/suspicious
- **Per-entry actions** — view resume, download docx, deep verify LinkedIn

## Customizing profiles

Edit `profiles.json` to add your own profile variants, skills, and keyword matching rules. See `profiles.example.json` for the format.

## Adding experiences

Add markdown files to `experiences/` with frontmatter:
```yaml
---
title: "Your Role"
company: "Company Name"
dates: "2020 – Present"
tags: [cto, founder, infra]
weight: 1
---
- [tag1,tag2] Bullet point only shown for matching profiles
```

## Importing emails via inbox files

Drop `.md` files in `inbox/` with frontmatter:
```markdown
---
from: "Sarah Chen <sarah@techrecruiters.com>"
subject: "Principal Engineer role"
---

Hi, I came across your profile...
```
Files without both `from` and `subject` are skipped.

## License

MIT
