# Quillnote

A free online notepad. Anyone can write without signing up. Guest notes save in the browser. A free account (Supabase Auth, email + password) keeps notes in the database, moves guest notes in automatically, and lets people share any note by link.

**Features:**
- Plain text, rich text, Markdown with a live split preview, and checklists, plus starter templates.
- Autosave, pinned notes, filters (all, pinned, shared), search and sort.
- Duplicate notes, undo after deleting, and focus mode.
- Font and size choice: sans, serif or mono.
- A command menu (Ctrl/⌘ K) and keyboard shortcuts.
- Drag-and-drop import of .txt, .md, .html and .docx files. Download as .txt, .md, .html or Word, or print to PDF.
- Read-only share links with an optional password and expiry.
- Accounts with email and password and no emails sent, with **Delete account**.
- Changes made offline are kept and synced later. The site installs as an app (PWA).
- An optional writing assistant (Claude) for signed-in users.

**Privacy and security:** the fonts (Inter, SIL OFL) and all libraries are self-hosted in `site/vendor` and `site/assets/fonts`, so loading the page contacts no third party. A strict Content Security Policy allows scripts and styles only from the site itself. Licences for bundled code are in `site/vendor/THIRD_PARTY_NOTICES.txt`.

```
site/                       the website (static files, deployed to GitHub Pages)
  index.html                app + product page
  config.js                 <- Supabase URL + anon key, brand, contact, legal details
  privacy.html, terms.html  legal pages (filled from config.js)
  manifest.webmanifest, sw.js   installable app + offline support
  assets/                   app.js, styles.css, theme.js, legal.js, icons, fonts/
  vendor/                   self-hosted libraries + THIRD_PARTY_NOTICES.txt
supabase/
  schema.sql                tables, Row Level Security, share + usage functions
  functions/ask/index.ts    Edge Function for the assistant (optional)
.github/workflows/deploy-pages.yml
```

The brand name is a setting: change `brandName` in `site/config.js`. The fallback text in `index.html` and `privacy.html` is replaced on load.

---

## 1. Set up the Supabase "notepad" project

1. **Database.** Open [supabase.com/dashboard](https://supabase.com/dashboard) → project **notepad** → **SQL Editor** → **New query**. Paste all of `supabase/schema.sql` and press **Run**. It's safe to run again later.
2. **Keys.** Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key into `site/config.js`:
   ```js
   supabaseUrl: "https://<your-ref>.supabase.co",
   supabaseAnonKey: "<anon public key>",
   ```
   The anon key is designed to be public. Row Level Security keeps every note private to its owner. **Never** put the `service_role` key in the site.
3. **Auth URLs.** Go to **Authentication → URL Configuration**:
   - **Site URL:** your live address, e.g. `https://vikramtkv.github.io/notepad/` (or your own domain).
   - **Redirect URLs:** add the same address, plus `http://localhost:8080/` if you test locally.
4. **Email + password, no emails sent.** The site is set up so it never sends email. Under **Authentication → Sign In / Providers**:
   - **Confirm email**: **off**. Accounts can be used the moment they're created.
   - **Email → Minimum password length**: **8**, matching the site's form.
   - **Email → Secure password change**: **off**, so signed-in people can change their password without an email check.

   The trade-off: there's no "Forgot password?" by email, so someone who forgets their password can't get back in on their own. The sign-in form tells people this, and shows `contactEmail` if you set it. To help a locked-out person, set a new password for them through Supabase's admin API (`auth.admin.updateUserById` with the service_role key, run from your own computer, never the website) and tell them the new password privately. The dashboard's **Send password recovery** button sends an email, so it won't work while email is off.
5. **Turning on password-reset emails later (optional).** Connect an email provider under **Authentication → Emails → SMTP Settings** (Resend, Postmark, Amazon SES…), brand the **Reset password** template, then set `passwordResetEmails: true` in `site/config.js`. That brings back the "Forgot password?" link. Supabase's built-in sender allows only a few emails an hour, so don't rely on it for the public.
6. **Google sign-in (optional).** Enable Google under **Authentication → Providers**, then set `googleSignIn: true` in `config.js`.

## 2. Assistant (optional)

The assistant runs in a Supabase Edge Function so your Claude API key never reaches the browser. Only signed-in users can call it, with a daily per-person limit.

1. Get an API key at [platform.claude.com](https://platform.claude.com).
2. Dashboard → **Edge Functions** → **Secrets**: add `ANTHROPIC_API_KEY`. Optional extras:
   - `CLAUDE_MODEL`: defaults to `claude-opus-5-5`. Set `claude-haiku-5-5` for a much cheaper assistant.
   - `AI_DAILY_LIMIT`: messages per person per day, default `30`.
   - `ALLOWED_ORIGIN`: your site origin, e.g. `https://vikramtkv.github.io`.
3. Dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**. Name it `ask`, paste `supabase/functions/ask/index.ts`, and deploy. Leave **Verify JWT** on.
   With the Supabase CLI it's `supabase link --project-ref <ref>` then `supabase functions deploy ask`.
4. Set `aiEnabled: true` in `site/config.js`.

## 3. Put the code on GitHub and go live

If Git isn't installed yet, install it once:

```bash
winget install --id Git.Git -e
```

Close and reopen the terminal, then from this folder:

```bash
git init -b main
git add .
git commit -m "Quillnote: online notepad with Supabase"
git remote add origin https://github.com/VikramTKV/notepad.git
git push -u origin main
```

If the repository on GitHub already has commits (for example a README made on github.com), run `git pull origin main --allow-unrelated-histories` before the push.

**Turn on GitHub Pages:** repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. Every push to `main` deploys the `site/` folder. The address appears in the **Actions** run, normally `https://vikramtkv.github.io/notepad/`.

- GitHub Pages on a **private** repository needs a paid GitHub plan. Make the repository public, or deploy `site/` to Netlify, Vercel or Cloudflare Pages instead (build command: none, output directory: `site`).
- **Custom domain:** Settings → Pages → Custom domain. Then update the Site URL and Redirect URLs in Supabase to match.

## 4. Test locally

Any static server works, for example with Python installed:

```bash
python -m http.server 8080 --directory site
```

Open http://localhost:8080/. Without Supabase keys in `config.js` the site runs in guest-only mode.

## Changing the Supabase project or brand

- **Supabase address:** it appears in two places, `site/config.js` and the Content-Security-Policy `connect-src` in `site/index.html`. Update both, or the site can't reach the database.
- **Brand name:** set `brandName` in `config.js`. Also update the `<title>` and description tags in the three HTML files and `name` in `manifest.webmanifest`, which browsers read before any script runs.

## Launch checklist

- [ ] `schema.sql` run in the notepad project
- [ ] `config.js` has the project URL and anon key (never the service_role key)
- [ ] Site URL and Redirect URLs set in Supabase Auth
- [ ] Decide on password recovery: keep it email-free (set `contactEmail` for locked-out people), or connect SMTP and set `passwordResetEmails: true`
- [ ] `contactEmail`, `operatorName` and `governingLaw` set in `config.js` (they feed the abuse-report link, Privacy and Terms)
- [ ] Privacy and Terms reviewed by a lawyer for your country (they're a plain-language starting point)
- [ ] Brand name cleared: search your country's trademark register, plus WIPO's Global Brand Database, for note-taking or software marks
- [ ] Assistant: `ANTHROPIC_API_KEY` secret set, function deployed, `aiEnabled: true`, spend limit set in the Claude Console
