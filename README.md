# Wallet

A wallet website. People sign up with an **email or phone number**, get a wallet balance, and add money with a **voucher code** or by paying through **Pay@ (payat.io)**.

No npm packages to install. It needs **Node 22.13 or newer** (it uses Node's built-in SQLite).

## Run it

```bash
cp .env.example .env      # then edit .env (see below)
npm start                 # http://localhost:3000
npm test                  # 24 end-to-end checks
```

- App: `http://localhost:3000`
- Voucher admin: `http://localhost:3000/admin` (needs `ADMIN_KEY` in `.env`, 16+ characters)

### Try everything before you have a Pay@ account

Put `DEMO_MODE=1` in `.env`. The Pay@ tab then shows a "Simulate payment" button that credits the wallet as if Pay@ had paid. **Turn it off before going live**, because anyone signed in could give themselves money.

## How it works

| Thing | How |
|---|---|
| Login | Email or phone, plus a password (scrypt-hashed). Phones typed with a leading 0 become `+27...` (change `DEFAULT_COUNTRY_CODE`). `082 123 4567` and `+27821234567` are the same account. |
| Wallet | One per account. Balance is stored in cents. Every change is a row in a history table, and the balance can never go below zero. |
| Vouchers | Create them at `/admin` (amount, how many). Codes look like `K7QM-3XWD-P9TR-HN2B`, are shown **once**, and are stored only as a hash. Each works once, and 5 wrong guesses lock redeeming for 15 minutes. |
| Pay@ | Each wallet has a 10-digit **reference number**. The customer pays Pay@ using that number and Pay@ tells your server, which credits the wallet. Repeated notifications for the same payment are ignored, so nobody is credited twice. |

## Connecting Pay@ (read this part)

From Pay@'s public site: businesses integrate by giving Pay@ an endpoint. Pay@ sends **real-time validation** requests ("is this account number valid?") and **payment notifications** to it. Customers pay with their reference number at retail partners, banks, mobile operators or the Pay@ portal.

This site already provides those two endpoints:

- `POST /api/payat/validate` tells Pay@ whether an account/reference exists
- `POST /api/payat/notify` credits the wallet when a payment is confirmed

**What I could not verify:** Pay@'s exact request format, field names, authentication method and the response they expect. Those are in the onboarding pack you receive when Pay@ approves your merchant account, and are not public. So the site is built to be adjusted to that spec:

1. Set `PAYAT_SECRET` in `.env`. Pay@'s requests are accepted if they carry it as `Authorization: Bearer ...` or `X-Payat-Secret`, or an HMAC-SHA256 signature of the body in `X-Signature`. Without it, all Pay@ calls are refused.
2. Open **`payat.js`**. It is the only file that knows Pay@'s format. Change the field names, the auth check, or the amount unit (`PAYAT_AMOUNT_IN_CENTS=1` if they send cents) to match the spec. The responses are in the two `/api/payat/...` cases in `server.js`.
3. Give Pay@ your two URLs, e.g. `https://yourdomain.co.za/api/payat/validate` and `.../notify`. Optionally lock them to Pay@'s IPs with `PAYAT_ALLOWED_IPS`.
4. Optional: set `PAYAT_PORTAL_URL` to your Pay@ portal link and a button appears in the app.

Every Pay@ call is logged in the `payat_events` table, which helps when debugging with their team.

## Putting it online

This is a Node server with a database file, so it needs a host that runs Node **and keeps a disk** (a small VPS, or a platform with a persistent volume). Static hosts such as GitHub Pages will not work.

- Serve it over **HTTPS** (Pay@ will require it anyway) and set `TRUST_PROXY=1` and `COOKIE_SECURE=1`.
- Point `DB_PATH` at the persistent disk, and back that file up.
- Keep `DEMO_MODE=0`.
- Set a long random `ADMIN_KEY` and `PAYAT_SECRET`.

## Before you hold other people's money

A wallet that stores customers' money can fall under South African rules for stored value and payments, and Pay@ will have its own merchant requirements. Check with Pay@ and a lawyer or your bank before launching to the public. This project does not do spending, withdrawals or refunds yet; it only takes money in.

## Files

```
server.js        API, database, sessions, vouchers, rate limits
payat.js         Pay@ adapter: auth + field names (edit this to match the Pay@ spec)
public/          the website (index.html, app.js, admin.html, admin.js, styles.css)
test.js          end-to-end tests
data/            SQLite database is created here
.env.example     all settings
```
