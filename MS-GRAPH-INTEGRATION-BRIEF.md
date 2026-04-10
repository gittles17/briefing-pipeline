# MS Graph API Integration — Technical Brief for IT Review

## What This Is

Jonathan's automated morning briefing pipeline runs at 4:30 AM and 3:00 PM daily on his Mac Studio. It pulls data from email, calendar, Teams, Notion, and RSS feeds, then generates a prioritized summary via Claude API and delivers it to his inbox.

Currently, M365 data (email, calendar, Teams) is only available during interactive Claude Code sessions via the MCP connector. The automated runs fall back to Apple Mail via AppleScript, which is slower and occasionally misses emails. We want the pipeline to query M365 directly so every run has fresh data.

## What We Need

A registered Azure AD application with **read-only** access to **Jonathan's account only**.

### Option A: Application Permissions (simpler, broader)

| Permission | Type | What It Does |
|---|---|---|
| `Mail.Read` | Application | Read mail in all mailboxes* |
| `Calendars.Read` | Application | Read calendars in all mailboxes* |
| `Chat.Read.All` | Application | Read all chat messages* |

*Application permissions are org-wide by default. Can be scoped to a single user using Exchange Application Access Policies: https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access

### Option B: Delegated Permissions with Refresh Token (tighter, recommended)

| Permission | Type | What It Does |
|---|---|---|
| `Mail.Read` | Delegated | Read Jonathan's mail only |
| `Calendars.Read` | Delegated | Read Jonathan's calendars only |
| `Chat.Read` | Delegated | Read Jonathan's Teams chats only |
| `offline_access` | Delegated | Allows token refresh without re-login |

This approach uses OAuth2 authorization code flow. Jonathan signs in once, we store a refresh token, and the pipeline uses it to get fresh access tokens on each run. Access is scoped entirely to Jonathan's account — no other users' data is accessible.

## What the Code Does

~100 lines of TypeScript. Three API calls per run:

```
GET /users/{jonathan}/messages?$filter=receivedDateTime ge {18h ago}&$top=50&$select=subject,sender,bodyPreview,receivedDateTime,importance,hasAttachments
GET /users/{jonathan}/calendar/calendarView?startDateTime={now}&endDateTime={+3 days}&$select=subject,start,end,attendees,location
GET /users/{jonathan}/chats/getAllMessages?$filter=createdDateTime ge {18h ago}&$top=50
```

All read-only. No write, send, delete, or modify operations. No access to other users' mailboxes.

## What We Need from IT

1. **App Registration** in Azure AD (portal.azure.com > App registrations)
   - Name: `Create Briefing Pipeline` (or whatever IT prefers)
   - Single tenant
   - Generate a client secret

2. **API Permissions** — either Option A or B above, with admin consent granted

3. **If Option A** — an Application Access Policy to restrict the app to Jonathan's mailbox only (optional but recommended)

4. **Three values** to add to the pipeline's `.env` file:
   - `AZURE_TENANT_ID`
   - `AZURE_CLIENT_ID`
   - `AZURE_CLIENT_SECRET`
   - Plus: `MS_USER_EMAIL=jonathan.gitlin@createadvertising.com`

## Security Notes

- The pipeline runs locally on Jonathan's Mac Studio — no cloud servers, no external hosting
- Credentials are stored in a `.env` file on the local machine only (not committed to any repo)
- The code is open for review: `/Users/jonathan.gitlin/Desktop/Brief/src/sources/`
- Happy to have Greptile or any code review tool audit the integration before credentials are issued
- The pipeline makes 3 read-only API calls, twice per day (4:30 AM and 3:00 PM)
- No data leaves the machine except the final briefing email sent via SMTP to Jonathan's inbox

## Questions?

Steve can reach out to Jonathan, or review the pipeline code directly on the Mac Studio.
