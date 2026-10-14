# Quillnote

A free online notepad. Anyone can write without signing up. Guest notes save in the browser. A free account (Supabase Auth, email link) keeps notes in the database, moves guest notes in automatically, and lets people share any note by link.

**Features:** plain text, rich text, Markdown with preview, task lists · autosave · search and sort · import .txt/.md/.html/.docx · download .txt/.md/.html/Word, print to PDF · read-only share links · optional writing assistant (Claude) for signed-in users.

```
site/                       the website (static files, deployed to GitHub Pages)
  index.html
  config.js                 <- your Supabase URL + anon key go here
  privacy.html
  assets/app.js, styles.css, favicon.svg
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
4. **Email sending (before launch).** Supabase's built-in email sender allows only a few sign-in emails per hour. That's fine for testing but not for the public. Under **Authentication → Emails → SMTP Settings**, connect a provider such as Resend, Postmark or Amazon SES. Edit the **Magic Link** template so it carries your brand name.
5. **Google sign-in (optional).** Enable Google under **Authentication → Providers**, then set `googleSignIn: true` in `config.js`.

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

## Launch checklist

- [ ] `schema.sql` run in the notepad project
- [ ] `config.js` has the project URL and anon key (never the service_role key)
- [ ] Site URL and Redirect URLs set in Supabase Auth
- [ ] Custom SMTP connected and email template branded
- [ ] `contactEmail` set in `config.js` (used for abuse reports and the privacy page)
- [ ] `privacy.html` reviewed for your situation; add terms of service if you need them
- [ ] Assistant: `ANTHROPIC_API_KEY` secret set, function deployed, `aiEnabled: true`, spend limit set in the Claude Console
