# auto-resume

AI-customized resume engine — generates unique, role-tailored resumes per recruiter with visit tracking.

## How it works

1. **Incoming webhook** receives recruiter emails → analyzes subject/body to match a profile (CTO, Architect, Full Stack, etc.)
2. **Stored as pending** in the admin queue — no auto-send (you review first)
3. **Admin panel** (`/admin`) lets you approve, skip, or delete entries
4. **Approved emails** get a custom reply with a link to a role-specific resume page
5. **Visit tracking** logs each resume view (IP, UA, timestamp)
6. **Word download** available at `/download/:slug`

## Setup

```bash
cp profiles.example.json profiles.json
# Edit profiles.json with your contact info, skills, and experience

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
| `MCP_API` | `http://localhost:3456/call` | Email sending API endpoint |
| `MCP_TOKEN` | — | Auth token for email API |

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
- Bullet point with tag filtering [tag1,tag2]
```

Each bullet point can include `[tag1,tag2]` prefixes to conditionally show points only for certain profiles.

## License

MIT
