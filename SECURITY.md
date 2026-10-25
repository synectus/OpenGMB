# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue.

- Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**.
- Or email info@synectus.com with "OpenGMB security" in the subject.

Include what you found, the steps to reproduce it, the version or commit, and the impact you see. Do not include other people's personal data. If you must show data, use mock mode.

## What to expect

- We aim to respond promptly. We make no promise about a fixed reply time.
- We tell you whether we accept the report and how we plan to fix it.
- We credit you in the fix notes if you want that.
- There is no bounty program.

## Safe harbour

If you make a good-faith effort to follow this policy, we consider your research on your own copy of the code authorised, and we will not bring or support legal action against you for accidental, good-faith breaches of this policy. This does not authorise testing of services we or you use, such as Google, Resend, Anthropic or DataForSEO.

## Rules

Test only with a copy of OpenGMB that you run yourself. Do not access, change or keep other people's data beyond the minimum needed to show the issue; if you reach personal data, stop, tell us, and delete it. No denial-of-service, social engineering, physical testing, or sending email through the review-request features. Give us 90 days to fix an issue before you publish it.

## In scope

- The web app (`apps/web`), the MCP server (`apps/mcp`) and the worker (`apps/worker`).
- Authentication, the owner login, approval and guardrail bypasses, token and API-key handling, webhooks, and the audit log.

## Out of scope

- Findings that need a stolen password or a device you already control.
- Denial of service by sending huge volumes of traffic.
- Problems in a third-party service such as Google, Resend or DataForSEO. Report those to the vendor.
- Your own server setup, such as a missing reverse proxy or an exposed database port.

## Running OpenGMB yourself

Keep your `.env` secret, put a TLS reverse proxy in front of it, keep the database private, use a strong owner password and update when we publish a fix.
